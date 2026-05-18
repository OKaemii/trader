import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Auth as AuthContracts } from '@trader/contracts';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import { verifyRefreshToken, signAccessToken } from '@trader/shared-auth/jwt';
import type { LoginUseCase } from '../application/LoginUseCase.ts';
import type { RegisterUseCase } from '../application/RegisterUseCase.ts';
import type { IUserRepository } from '../domain/IUserRepository.ts';
import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';

export function createPublicRouter(login: LoginUseCase, register: RegisterUseCase, users: IUserRepository): Hono {
    const app = new Hono();

    // /api/auth/* — public, no auth header required. These ARE the auth endpoints.
    app.post(
        '/api/auth/register',
        zValidator('json', AuthContracts.RegisterRequestSchema),
        async (c) => {
            const { email, password } = c.req.valid('json');
            if (!email || !password) return c.json({ error: 'email and password required' }, 400);
            try {
                const result = await register.execute(email, password);
                return c.json(result, 201);
            } catch (err: unknown) {
                if ((err as { code?: string }).code === 'CONFLICT') return c.json({ error: 'Email already registered' }, 409);
                throw err;
            }
        },
    );

    app.post(
        '/api/auth/login',
        zValidator('json', AuthContracts.LoginRequestSchema, (result, c) => {
            if (!result.success) return c.json({ error: 'email and password required' }, 400);
        }),
        async (c) => {
            const { email, password } = c.req.valid('json');
            try {
                const tokens = await login.execute(email, password);
                return c.json(tokens);
            } catch (err: unknown) {
                if ((err as { code?: string }).code === 'UNAUTHORIZED') return c.json({ error: 'Invalid credentials' }, 401);
                throw err;
            }
        },
    );

    app.post(
        '/api/auth/refresh',
        zValidator('json', AuthContracts.RefreshRequestSchema),
        async (c) => {
            const { refreshToken } = c.req.valid('json');
            try {
                const { sub } = await verifyRefreshToken(refreshToken);
                const user = await users.findById(sub);
                if (!user) return c.json({ error: 'User not found' }, 401);
                const accessToken = await signAccessToken({ sub, role: user.role });
                return c.json({ accessToken });
            } catch {
                return c.json({ error: 'Invalid refresh token' }, 401);
            }
        },
    );

    // /admin/api/auth/* — admin-only.
    app.use('/admin/api/auth/*', parseAdminHeaders);
    app.get('/admin/api/auth/users', async (c) => {
        const db = await getMongoDb();
        const users = await db.collection(COLLECTIONS.USERS).find({}, {
            projection: { passwordHash: 0 },
        }).toArray();
        return c.json({ users });
    });

    return app;
}
