import { Hono } from 'hono';
import { requireAuth } from '@trader/shared-auth/middleware';
import { requireInternalToken } from '@trader/shared-auth/middleware';
import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';

const app = new Hono();

// Sync positions from trading-service on schedule
async function syncPositions(): Promise<void> {
  try {
    const res = await fetch('http://trading-service:3005/internal/trading/positions', {
      headers: { 'X-Internal-Token': process.env.INTERNAL_TOKEN_BOOTSTRAP ?? 'dev' },
    });
    if (!res.ok) return;
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

app.route('/', authed);
app.get('/health', (c) => c.json({ status: 'ok' }));

// Sync positions every 5 minutes
setInterval(syncPositions, 5 * 60 * 1000);
syncPositions();

export default { port: 3006, fetch: app.fetch };
