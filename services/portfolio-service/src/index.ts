import { Hono } from 'hono';
import { requireAuth, generateInternalToken } from '@trader/shared-auth';
import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';
import { getRedisClient } from '@trader/shared-redis';
import { type Money, type Currency, BASE_CURRENCY } from '@trader/shared-types';
import { FxClient, YahooFxProvider } from '@trader/shared-fx';
import { sumPositionsGBP, type PositionDoc } from '@trader/shared-portfolio';
import { buildPositionUpdate } from './sync.ts';

const app = new Hono();

// Lazy FxClient singleton — used to convert each position's instrument-currency value
// into BASE_CURRENCY (GBP) once per sync, so RiskEngine and the portal can sum NAV
// without doing FX in the hot path.
let _fxClient: FxClient | null = null;
async function getFxClient(): Promise<FxClient> {
  if (_fxClient) return _fxClient;
  const redis = await getRedisClient();
  _fxClient = new FxClient(redis as any, new YahooFxProvider());
  return _fxClient;
}

// Sync positions from trading-service on schedule
let tradingServiceUnreachableLogged = false;
async function syncPositions(): Promise<void> {
  try {
    const headers = { 'X-Internal-Token': generateInternalToken('portfolio-service') };
    const [posRes, cashRes] = await Promise.all([
      fetch('http://trading-service:3005/internal/trading/positions', { headers }),
      fetch('http://trading-service:3005/internal/trading/cash', { headers }),
    ]);
    if (!posRes.ok) return;
    tradingServiceUnreachableLogged = false;

    // Wire format post-FX-fix: positions carry Money fields keyed by currency.
    interface IncomingPosition {
      ticker: string;
      quantity: number;
      averagePrice?: Money;
      currentPrice?: Money;
      currentValue?: Money;
    }
    const { positions } = await posRes.json() as { positions: IncomingPosition[] };

    // Cash is GBP per T212 UK base. Used as denominator for portfolio weights — total
    // NAV (cash + holdings) so weights sum to <1 when there's free cash to deploy.
    let cashGBP: number | undefined;
    if (cashRes.ok) {
      const raw = await cashRes.json() as {
        free?:  { amount?: number; currency?: string };
        total?: { amount?: number; currency?: string };
      };
      const totalAmt = raw.total?.amount ?? raw.free?.amount;
      if (typeof totalAmt === 'number' && (raw.total?.currency ?? raw.free?.currency) === 'GBP') {
        cashGBP = totalAmt;
      }
    }

    const fx = await getFxClient();

    // First pass: extract native-currency price and value. No FX yet — positions are
    // stored canonically as Money in the instrument's listing currency. GBP NAV is
    // derived on read by RiskEngine via sumPositionsGBP.
    const sized = positions.map((p) => {
      const q = typeof p.quantity === 'number' ? p.quantity : 0;
      const ccy: Currency = (p.currentPrice?.currency
        ?? p.averagePrice?.currency
        ?? BASE_CURRENCY) as Currency;
      const priceNative = p.currentPrice?.amount ?? 0;
      const valueNative = q * priceNative;
      return { p, q, ccy, priceNative, valueNative };
    });

    // Compute positionsGBP once for the weight denominator. If FX is unavailable
    // (live Yahoo failed AND lastGood is stale past 24h), skip the entire sync rather
    // than persist weights derived from a stale or fabricated value — the next 5min
    // tick retries. The 100x bug class came from silently substituting native scalars
    // into GBP-named columns; this helper either succeeds or throws, never lies.
    const positionsForSum: PositionDoc[] = sized.map((s) => ({
      ticker:   s.p.ticker,
      quantity: s.q,
      currency: s.ccy,
      currentValue: { amount: s.valueNative, currency: s.ccy },
    }));
    let positionsGBP = 0;
    try {
      positionsGBP = await sumPositionsGBP(positionsForSum, fx);
    } catch (err) {
      console.warn('[portfolio] FX unavailable — skipping sync to avoid stale weights:', err);
      return;
    }
    // Fallback NAV basis: cash endpoint unavailable → weight against holdings-only
    // value so SELLs can still fire on the largest positions.
    const navBasisGBP = cashGBP && cashGBP > 0 ? cashGBP : positionsGBP;

    const db = await getMongoDb();
    for (const { p, q, ccy, priceNative, valueNative } of sized) {
      // Per-row GBP for the weight calculation. FX rate is Redis-cached for 1h, so
      // this is N in-memory multiplies + 0–1 Redis GETs total for the batch.
      const valueGBP = navBasisGBP > 0 && valueNative > 0
        ? await fx.toGBP({ amount: valueNative, currency: ccy })
        : 0;
      const weight = navBasisGBP > 0 ? valueGBP / navBasisGBP : 0;
      const update = buildPositionUpdate({
        ticker:      p.ticker,
        quantity:    q,
        currency:    ccy,
        priceNative,
        valueNative,
        weight,
      });
      await db.collection(COLLECTIONS.POSITIONS).updateOne(
        { ticker: p.ticker },
        update,
        { upsert: true },
      );
    }

    // Drop positions that T212 no longer reports (sold to zero) so currentWeights doesn't
    // keep returning stale exposure that blocks new BUYs on the same ticker.
    const heldTickers = positions
      .map((p) => p.ticker)
      .filter((t): t is string => typeof t === 'string');
    await db.collection(COLLECTIONS.POSITIONS).deleteMany({ ticker: { $nin: heldTickers } });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } })?.cause;
    const code = cause?.code ?? (e as { code?: string })?.code;
    // Node libuv-style codes (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) AND Bun's
    // fetch error strings (`ConnectionRefused`, `UnknownHostname`, `ConnectionTimeout`).
    // Without the Bun variants every boot race where trading-service comes up after
    // portfolio-service emits a noisy stack trace instead of the suppressed warning.
    const unreachableCodes = new Set([
      'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
      'ConnectionRefused', 'UnknownHostname', 'ConnectionTimeout', 'Timeout',
    ]);
    if (code && unreachableCodes.has(code)) {
      if (!tradingServiceUnreachableLogged) {
        console.warn('[portfolio] trading-service unreachable, skipping position sync');
        tradingServiceUnreachableLogged = true;
      }
      return;
    }
    console.error('[portfolio] sync error:', e);
  }
}

// Authenticated portfolio routes
const authed = new Hono();
authed.use('*', requireAuth);

authed.get('/api/portfolio', async (c) => {
  const db = await getMongoDb();
  const positions = await db.collection(COLLECTIONS.POSITIONS).find({}).toArray();
  return c.json({ positions });
});

authed.get('/api/portfolio/pnl', async (c) => {
  const db = await getMongoDb();
  const positions = await db.collection(COLLECTIONS.POSITIONS).find({}).toArray() as unknown as PositionDoc[];
  const fx = await getFxClient();
  // Total value in GBP via the single read-side helper that owns the FX call.
  // Throws if FX is unavailable past the 24h stale window — better to surface a 502
  // than to compute P&L against a fabricated GBP figure.
  let totalValueGBP: number;
  try {
    totalValueGBP = await sumPositionsGBP(positions, fx);
  } catch (err) {
    return c.json({ error: 'fx unavailable for P&L computation' }, 502);
  }
  // costBasisGBP is the GBP at entry — set at trade close time, not FX-converted on
  // read. A legacy row without it contributes 0 to cost rather than mixing in a
  // native-currency scalar.
  const totalCostGBP = positions.reduce((a: number, p: any) =>
    a + (typeof p.costBasisGBP === 'number' ? p.costBasisGBP : 0),
  0);
  return c.json({
    totalValueGBP,
    totalCostGBP,
    unrealisedPnLGBP: totalValueGBP - totalCostGBP,
    positions: positions.length,
  });
});

app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/', authed);

// Sync positions every 5 minutes
setInterval(syncPositions, 5 * 60 * 1000);
syncPositions();

export default { port: 3006, fetch: app.fetch };
