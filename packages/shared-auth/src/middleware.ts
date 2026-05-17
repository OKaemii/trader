import type { Context, Next } from 'hono';
import { verifyAccessToken, verifyTokenForAudience, type TokenClaims, type UserRole } from './jwt.ts';
import { validateInternalToken } from './internal-token.ts';
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

export function requireInternalToken(...callerServices: string[]) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const token = c.req.header('X-Internal-Token');
    if (!token) return c.json({ error: 'Forbidden' }, 403);
    for (const caller of callerServices) {
      try {
        validateInternalToken(token, caller);
        return next();
      } catch {
        // try next allowed caller
      }
    }
    return c.json({ error: 'Forbidden' }, 403);
  };
}

// ── Audience-based JWT middleware (blueprint §11) ────────────────────────────
// One verification primitive. `aud` is the authorization gate; `sub` carries the caller
// identity (user id for end-users, service name for peers). Issued by auth-service at login
// and by `mintInternalJwt` for service-to-service calls. Replaces the HMAC path as callers
// and callees flip over.

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
 * Transition shim. Accept either the new audience Bearer JWT (aud='internal') OR the legacy
 * HMAC X-Internal-Token from any of `callerServices`. Used during Phase 4 migration so
 * callers and callees can flip independently; deleted in the final commit of Phase 4.
 */
export function requireInternalAny(...callerServices: string[]) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const bearer = extractBearer(c);
    if (bearer) {
      try {
        const claims = await verifyTokenForAudience(bearer, 'internal');
        c.set('auth', claims);
        return next();
      } catch { /* fall through to HMAC */ }
    }
    const hmac = c.req.header('X-Internal-Token');
    if (hmac) {
      for (const caller of callerServices) {
        try {
          validateInternalToken(hmac, caller);
          c.set('hmacCaller', caller);
          return next();
        } catch { /* try next */ }
      }
    }
    return c.json({ error: 'Forbidden' }, 403);
  };
}

export type { TokenClaims };
