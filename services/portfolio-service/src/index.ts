import { Hono } from 'hono';
import { requireAuth, generateInternalToken } from '@trader/shared-auth';
import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';

const app = new Hono();

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

    const { positions } = await posRes.json() as { positions: Array<Record<string, unknown>> };

    // Compute portfolio weights so signal-service's optimiser sees current exposure.
    // Weight basis is total NAV (cash + holdings), not just invested value — otherwise
    // weights sum to 1 by construction and the optimiser can't decide to deploy fresh cash.
    // Cash fetch is best-effort: if it fails we still write positions but skip the weight
    // field so MongoPortfolioState ignores stale weights instead of acting on bad ones.
    let totalNAV: number | undefined;
    if (cashRes.ok) {
      const cash = await cashRes.json() as { total?: number; free?: number };
      totalNAV = cash.total ?? cash.free;
    }

    const positionsValue = positions.reduce((acc, p) => {
      const q = typeof p.quantity === 'number' ? p.quantity : 0;
      const px = typeof p.currentPrice === 'number' ? p.currentPrice : 0;
      return acc + q * px;
    }, 0);
    // Fallback NAV: if cash endpoint is unavailable, weight against holdings-only value
    // so SELLs can still fire on the largest positions. Surface this in logs once.
    const navBasis = totalNAV && totalNAV > 0 ? totalNAV : positionsValue;

    const db = await getMongoDb();
    for (const pos of positions) {
      const q = typeof pos.quantity === 'number' ? pos.quantity : 0;
      const px = typeof pos.currentPrice === 'number' ? pos.currentPrice : 0;
      const value = q * px;
      const weight = navBasis > 0 ? value / navBasis : 0;
      await db.collection(COLLECTIONS.POSITIONS).updateOne(
        { ticker: pos.ticker },
        { $set: { ...pos, currentValue: value, weight, updatedAt: new Date() } },
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
  const totalValue = positions.reduce((a: number, p: any) => a + (p.currentValue ?? 0), 0);
  const totalCost  = positions.reduce((a: number, p: any) => a + (p.costBasis ?? 0), 0);
  return c.json({
    totalValue,
    totalCost,
    unrealisedPnL: totalValue - totalCost,
    positions: positions.length,
  });
});

app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/', authed);

// Sync positions every 5 minutes
setInterval(syncPositions, 5 * 60 * 1000);
syncPositions();

export default { port: 3006, fetch: app.fetch };
