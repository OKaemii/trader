import { Hono } from 'hono';
import { requireAuth, generateInternalToken } from '@trader/shared-auth';
import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';

const app = new Hono();

// Sync positions from trading-service on schedule
let tradingServiceUnreachableLogged = false;
async function syncPositions(): Promise<void> {
  try {
    const res = await fetch('http://trading-service:3005/internal/trading/positions', {
      headers: { 'X-Internal-Token': generateInternalToken('portfolio-service') },
    });
    if (!res.ok) return;
    tradingServiceUnreachableLogged = false;
    const { positions } = await res.json() as { positions: Array<Record<string, unknown>> };
    const db = await getMongoDb();
    for (const pos of positions) {
      await db.collection(COLLECTIONS.POSITIONS).updateOne(
        { ticker: pos.ticker },
        { $set: { ...pos, updatedAt: new Date() } },
        { upsert: true },
      );
    }
  } catch (e) {
    const cause = (e as { cause?: { code?: string } })?.cause;
    const code = cause?.code ?? (e as { code?: string })?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
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
