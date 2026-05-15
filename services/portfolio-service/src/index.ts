import { Hono } from 'hono';
import { requireAuth, generateInternalToken } from '@trader/shared-auth';
import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';
import { getRedisClient } from '@trader/shared-redis';
import { type Money, type Currency, BASE_CURRENCY } from '@trader/shared-types';
import { FxClient, YahooFxProvider } from '@trader/shared-fx';

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

    // First pass: compute each position's GBP value via FX. Done in one pass so we can
    // sum positionsGBP for the weight denominator before the second pass writes weights.
    const sized = await Promise.all(positions.map(async (p) => {
      const q = typeof p.quantity === 'number' ? p.quantity : 0;
      const ccy: Currency = (p.currentPrice?.currency
        ?? p.averagePrice?.currency
        ?? BASE_CURRENCY) as Currency;
      const priceNative = p.currentPrice?.amount ?? 0;
      const valueNative = q * priceNative;
      let valueGBP = valueNative;
      if (ccy !== BASE_CURRENCY && valueNative > 0) {
        try {
          valueGBP = await fx.toGBP({ amount: valueNative, currency: ccy });
        } catch (err) {
          console.warn(`[portfolio] FX conversion failed for ${p.ticker} (${ccy}); falling back to native value:`, err);
        }
      }
      return { p, q, ccy, priceNative, valueNative, valueGBP };
    }));

    const positionsGBP = sized.reduce((acc, s) => acc + s.valueGBP, 0);
    // Fallback NAV: cash endpoint unavailable → weight against holdings-only value so
    // SELLs can still fire on the largest positions. Surface in logs once.
    const navBasisGBP = cashGBP && cashGBP > 0 ? cashGBP : positionsGBP;

    const db = await getMongoDb();
    for (const { p, q, ccy, priceNative, valueNative, valueGBP } of sized) {
      const weight = navBasisGBP > 0 ? valueGBP / navBasisGBP : 0;
      // Persist BOTH native (instrument currency) and GBP. RiskEngine sums currentValueGBP;
      // the portal can show either. weight is dimensionless.
      await db.collection(COLLECTIONS.POSITIONS).updateOne(
        { ticker: p.ticker },
        { $set: {
          ticker: p.ticker,
          quantity: q,
          currency: ccy,
          currentPrice: priceNative,
          currentValue: valueNative,        // instrument currency
          currentValueGBP: valueGBP,        // BASE_CURRENCY
          weight,
          updatedAt: new Date(),
        }},
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
  const positions = await db.collection(COLLECTIONS.POSITIONS).find({}).toArray();
  // P&L sums in GBP (the only common currency across mixed-market positions). Falls
  // back to currentValue for legacy rows pre-FX-fix that don't have currentValueGBP yet.
  const totalValueGBP = positions.reduce((a: number, p: any) =>
    a + (typeof p.currentValueGBP === 'number' ? p.currentValueGBP : (p.currentValue ?? 0)),
  0);
  const totalCostGBP  = positions.reduce((a: number, p: any) =>
    a + (typeof p.costBasisGBP === 'number' ? p.costBasisGBP : (p.costBasis ?? 0)),
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
