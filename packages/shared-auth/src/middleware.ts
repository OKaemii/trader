import type { Context, Next } from 'hono';
import { verifyAccessToken, type UserRole } from './jwt.ts';
import { validateInternalToken } from './internal-token.ts';

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const payload = await verifyAccessToken(header.slice(7));
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
