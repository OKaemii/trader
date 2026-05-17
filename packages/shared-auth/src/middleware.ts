import type { Context, Next } from 'hono';
import { verifyAccessToken, verifyTokenForAudience, type TokenClaims, type UserRole } from './jwt.ts';
import type { Audience } from './audiences.ts';

// Extract the bearer token from either `Authorization: Bearer …` (server-to-server,
// portal authedFetch) or the `at` cookie (browser XHR from client components).
// The cookie path lets client-rendered components hit /api/* through the ingress
// without the portal having to proxy every endpoint as a Next route handler.
function extractBearer(c: Context): string | null {
    const header = c.req.header('Authorization');
    if (header?.startsWith('Bearer ')) return header.slice(7);
    const cookieHeader = c.req.header('Cookie');
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const [rawName, ...rest] = part.trim().split('=');
        if (rawName === 'at') return decodeURIComponent(rest.join('='));
    }
    return null;
}

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
    const token = extractBearer(c);
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    try {
        const payload = await verifyAccessToken(token);
        c.set('user', payload);
        return next();
    } catch {
        return c.json({ error: 'Invalid or expired token' }, 401);
    }
}

export function requireRole(role: UserRole) {
    return async (c: Context, next: Next): Promise<Response | void> => {
        const user = c.get('user');
        if (!user) return c.json({ error: 'Unauthorized' }, 401);
        if (role === 'admin' && user.role !== 'admin') {
            return c.json({ error: 'Forbidden' }, 403);
        }
        return next();
    };
}

// ── Audience-based JWT middleware (blueprint §11) ────────────────────────────
// One verification primitive. `aud` is the authorization gate; `sub` carries the caller
// identity (user id for end-users, service name for peers). Issued by auth-service at login
// and by `mintInternalJwt` for service-to-service calls.

export const requireAudience = (audience: Audience | readonly Audience[]) =>
    async (c: Context, next: Next): Promise<Response | void> => {
        const token = extractBearer(c);
        if (!token) return c.json({ error: 'Unauthorized' }, 401);
        const list = Array.isArray(audience) ? audience : [audience as Audience];
        for (const aud of list) {
            try {
                const claims = await verifyTokenForAudience(token, aud);
                c.set('auth', claims);
                return next();
            } catch { /* try next */ }
        }
        return c.json({ error: 'Unauthorized' }, 401);
    };

// Admins can use user-scope endpoints; non-admins cannot reach admin scope.
export const requireUser     = requireAudience(['user', 'admin']);
export const requireAdmin    = requireAudience('admin');
export const requireInternal = requireAudience('internal');

/**
 * Per-peer access check. Compose AFTER `requireInternal`: validates that the verified
 * JWT's `sub` claim names one of the allowed peer services.
 *
 *   app.post('/internal/x', requireInternal, requireCaller('signal-service'), handler)
 */
export function requireCaller(...allowedCallers: string[]) {
    const allowed = new Set(allowedCallers);
    return async (c: Context, next: Next): Promise<Response | void> => {
        const claims = c.get('auth') as TokenClaims | undefined;
        if (!claims || !allowed.has(claims.sub)) {
            return c.json({ error: 'Forbidden' }, 403);
        }
        return next();
    };
}

export type { TokenClaims };
