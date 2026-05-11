import { Hono } from 'hono';
import { requireInternalToken } from '@trader/shared-auth/middleware';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '@trader/shared-auth/jwt';
import { getRedisClient } from '@trader/shared-redis';
import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';
import { randomUUID } from 'node:crypto';

const app = new Hono();

// ── Public ────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return c.json({ error: 'email and password required' }, 400);
  const db = await getMongoDb();
  const existing = await db.collection(COLLECTIONS.USERS).findOne({ email });
  if (existing) return c.json({ error: 'Email already registered' }, 409);
  const bcrypt = await import('bcryptjs');
  const hash = await bcrypt.hash(password, 12);
  const id = randomUUID();
  await db.collection(COLLECTIONS.USERS).insertOne({
    _id: id,
    email,
    passwordHash: hash,
    role: 'user',
    createdAt: new Date(),
  });
  return c.json({ id }, 201);
});

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  const db = await getMongoDb();
  const user = await db.collection(COLLECTIONS.USERS).findOne({ email });
  if (!user) return c.json({ error: 'Invalid credentials' }, 401);
  const bcrypt = await import('bcryptjs');
  const ok = await bcrypt.compare(password, user.passwordHash as string);
  if (!ok) return c.json({ error: 'Invalid credentials' }, 401);

  const accessToken  = await signAccessToken({ sub: String(user._id), role: user.role as 'admin' | 'user' });
  const refreshToken = await signRefreshToken(String(user._id));

  const redis = await getRedisClient();
  await redis.setEx(`refresh:${String(user._id)}:${randomUUID()}`, 7 * 86400, refreshToken);

  return c.json({ accessToken, refreshToken });
});

app.post('/api/auth/refresh', async (c) => {
  const { refreshToken } = await c.req.json<{ refreshToken: string }>();
  try {
    const { sub } = await verifyRefreshToken(refreshToken);
    const db = await getMongoDb();
    const user = await db.collection(COLLECTIONS.USERS).findOne({ _id: sub });
    if (!user) return c.json({ error: 'User not found' }, 401);
    const newAccess = await signAccessToken({ sub, role: user.role as 'admin' | 'user' });
    return c.json({ accessToken: newAccess });
  } catch {
    return c.json({ error: 'Invalid refresh token' }, 401);
  }
});

// ── Internal (called by gateway admin routes) ─────────────────────────────────
const internal = new Hono();
internal.use('*', requireInternalToken('api-gateway'));

internal.get('/api/admin/users', async (c) => {
  const db = await getMongoDb();
  const users = await db.collection(COLLECTIONS.USERS).find({}, {
    projection: { passwordHash: 0 },
  }).toArray();
  return c.json({ users });
});

app.route('/', internal);
app.get('/health', (c) => c.json({ status: 'ok' }));

export default { port: 3001, fetch: app.fetch };
