import type { Context, Next } from 'hono';
import { verifyAccessToken, type UserRole } from './jwt.ts';
import { validateInternalToken } from './internal-token.ts';

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

export function requireInternalToken(callerService: string) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const token = c.req.header('X-Internal-Token');
    if (!token) return c.json({ error: 'Forbidden' }, 403);
    try {
      validateInternalToken(token, callerService);
      return next();
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
  };
}
