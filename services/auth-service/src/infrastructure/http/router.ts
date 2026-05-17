import { Hono } from 'hono';
import { requireInternalAny } from '@trader/shared-auth/middleware';
import { verifyRefreshToken, signAccessToken } from '@trader/shared-auth/jwt';
import type { LoginUseCase } from '../../application/use-cases/LoginUseCase.ts';
import type { RegisterUseCase } from '../../application/use-cases/RegisterUseCase.ts';
import type { IUserRepository } from '../../domain/interfaces/IUserRepository.ts';
import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';

export function createPublicRouter(login: LoginUseCase, register: RegisterUseCase, users: IUserRepository) {
  const app = new Hono();

  app.post('/api/auth/register', async (c) => {
    const { email, password } = await c.req.json<{ email: string; password: string }>();
    if (!email || !password) return c.json({ error: 'email and password required' }, 400);
    try {
      const result = await register.execute(email, password);
      return c.json(result, 201);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'CONFLICT') return c.json({ error: 'Email already registered' }, 409);
      throw err;
    }
  });

  app.post('/api/auth/login', async (c) => {
    let body: { email?: string; password?: string };
    try {
      body = await c.req.json<{ email?: string; password?: string }>();
    } catch {
      return c.json({ error: 'email and password required' }, 400);
    }
    const { email, password } = body;
    if (!email || !password) return c.json({ error: 'email and password required' }, 400);
    try {
      const tokens = await login.execute(email, password);
      return c.json(tokens);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'UNAUTHORIZED') return c.json({ error: 'Invalid credentials' }, 401);
      throw err;
    }
  });

  app.post('/api/auth/refresh', async (c) => {
    const { refreshToken } = await c.req.json<{ refreshToken: string }>();
    try {
      const { sub } = await verifyRefreshToken(refreshToken);
      const user = await users.findById(sub);
      if (!user) return c.json({ error: 'User not found' }, 401);
      const accessToken = await signAccessToken({ sub, role: user.role });
      return c.json({ accessToken });
    } catch {
      return c.json({ error: 'Invalid refresh token' }, 401);
    }
  });

  return app;
}

export function createInternalRouter() {
  const internal = new Hono();
  internal.use('*', requireInternalAny('api-gateway'));

  internal.get('/api/admin/users', async (c) => {
    const db = await getMongoDb();
    const users = await db.collection(COLLECTIONS.USERS).find({}, {
      projection: { passwordHash: 0 },
    }).toArray();
    return c.json({ users });
  });

  return internal;
}
