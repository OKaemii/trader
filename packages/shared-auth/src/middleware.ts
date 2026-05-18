// Audience-based header parsers — the only auth primitives the cluster needs.
//
// Architecture: dumb pipes (nginx-ingress routes by path prefix), smart services
// (each service verifies its own auth via the parser that matches the route's audience).
// The path prefix tells the proxy which service to route to; it tells the service which
// parser to mount.
//
// Path convention                  Parser                      Token shape
// ──────────────────────────────    ─────────────────────────   ─────────────────────────
// /api/<service>/...                parseUserHeaders            aud='user' or 'admin'
// /admin/api/<service>/...          parseAdminHeaders           aud='admin'
// /internal/api/<service>/...       parseInternalHeaders(...)   aud='internal', sub in callers
// /debug/api/<service>/...          parseDebugHeaders           dev-only, fails closed in prod
//
// Each service picks per-endpoint:
//   router.use('/api/signals/*',        parseUserHeaders)
//   router.use('/admin/api/signals/*',  parseAdminHeaders)
//   router.use('/internal/api/signals/*', parseInternalHeaders('trading-service', 'api-gateway'))

import type { Context, Next } from 'hono';
import { verifyTokenForAudience, verifyAccessToken, type TokenClaims } from './jwt.ts';
import type { Audience } from './audiences.ts';

// Extract the bearer token from either `Authorization: Bearer …` (server-to-server +
// portal authedFetch) or the `at` cookie (browser XHR from client components hitting
// the ingress directly without the portal proxying the request).
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

// ── parseUserHeaders ─────────────────────────────────────────────────────────
// /api/<service>/* — admins can hit user-scope endpoints; non-admin user JWTs work too.
export async function parseUserHeaders(c: Context, next: Next): Promise<Response | void> {
    const token = extractBearer(c);
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    try {
        const claims = await verifyTokenForAudience(token, ['user', 'admin']);
        c.set('user', claims);
        return next();
    } catch {
        return c.json({ error: 'Invalid or expired token' }, 401);
    }
}

// ── parseAdminHeaders ────────────────────────────────────────────────────────
// /admin/api/<service>/* — admin-role users only.
export async function parseAdminHeaders(c: Context, next: Next): Promise<Response | void> {
    const token = extractBearer(c);
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    try {
        const claims = await verifyTokenForAudience(token, 'admin');
        c.set('user', claims);
        return next();
    } catch {
        // Distinguish "expired/invalid token" (→ 401, refreshable) from "valid token
        // but wrong audience" (→ 403, actual permission denial). Without this split,
        // any expired access token would render the portal's "Admin role required"
        // message even though the user IS admin — the auth-fetch retry layer only
        // refreshes on 401, so 403 short-circuits the refresh.
        try {
            await verifyAccessToken(token);
            // Token is structurally valid (signature OK, not expired) but failed the
            // audience check above — the caller is authenticated but not admin.
            return c.json({ error: 'Forbidden — admin only' }, 403);
        } catch {
            // Signature failed or token expired — let the client refresh.
            return c.json({ error: 'Invalid or expired token' }, 401);
        }
    }
}

// ── parseInternalHeaders ─────────────────────────────────────────────────────
// /internal/api/<service>/* — peer-to-peer calls. `allowedCallers` pins the caller-service
// names (`sub` claim) that may invoke this route. Mint with `mintInternalJwt('<caller>')`.
export function parseInternalHeaders(...allowedCallers: string[]) {
    const allowed = new Set(allowedCallers);
    return async (c: Context, next: Next): Promise<Response | void> => {
        const token = extractBearer(c);
        if (!token) return c.json({ error: 'Unauthorized' }, 401);
        try {
            const claims = await verifyTokenForAudience(token, 'internal');
            if (allowed.size > 0 && !allowed.has(claims.sub)) {
                return c.json({ error: 'Forbidden — caller not allowed' }, 403);
            }
            c.set('caller', claims);
            return next();
        } catch {
            return c.json({ error: 'Invalid or expired token' }, 401);
        }
    };
}

// ── parseDebugHeaders ────────────────────────────────────────────────────────
// /debug/api/<service>/* — local-dev tooling. Fails closed when NODE_ENV=production so
// even if an operator accidentally mounts a debug route in a prod chart, the endpoint
// is unreachable.
export async function parseDebugHeaders(c: Context, next: Next): Promise<Response | void> {
    if (process.env.NODE_ENV === 'production') {
        return c.json({ error: 'Not found' }, 404);
    }
    return next();
}

// ── Factory ──────────────────────────────────────────────────────────────────
// `createHeaderParser('admin')` is equivalent to `parseAdminHeaders`. Use the named
// exports above when the audience is known at module scope; use the factory when the
// audience is data-driven (e.g. wiring routes from a manifest).
export type ParserAudience = Audience | 'debug';
export interface ParserOptions {
    allowedCallers?: readonly string[];
}
export function createHeaderParser(audience: ParserAudience, opts: ParserOptions = {}) {
    switch (audience) {
        case 'user':     return parseUserHeaders;
        case 'admin':    return parseAdminHeaders;
        case 'internal': return parseInternalHeaders(...(opts.allowedCallers ?? []));
        case 'debug':    return parseDebugHeaders;
        case 'login':
        case 'refresh':  throw new Error(`createHeaderParser: audience='${audience}' is reserved for auth-service tokens; not usable as a route parser`);
    }
}

export type { TokenClaims };
