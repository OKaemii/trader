import type { Context } from "hono";

/**
 * HTTP proxy helper. Forwards the inbound request to `upstream` with the path + query
 * intact, **preserves the inbound Authorization header** so downstream services see the
 * end-user's JWT (admins keep aud='admin'; users keep aud='user'), and unwraps the
 * upstream response into Hono's mutable-headered Response so downstream cors middleware
 * can mutate headers without crashing on `TypeError: immutable`.
 *
 * Why preserve user auth instead of minting an internal JWT here:
 *   Downstream services need to know *who* the request is for so role checks
 *   (requireRole('admin')) and per-user filtering work. The previous behaviour
 *   replaced the Authorization header with an internal JWT (sub='api-gateway',
 *   no role), which forced every downstream admin route to 403. Internal JWT
 *   minting is reserved for peer-to-peer service calls (TradingServiceClient,
 *   SignalServiceClient, etc.); the gateway is *not* acting as itself when
 *   proxying — it's the user's reverse proxy.
 */
export async function proxy(upstream: string, c: Context): Promise<Response> {
    const path = c.req.path;
    const qs = c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : "";
    const url = `${upstream}${path}${qs}`;
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    // Node's fetch (undici) rejects streamed request bodies without `duplex: 'half'`.
    // Buffer the body up front so undici sees plain bytes.
    const body = hasBody ? await c.req.raw.arrayBuffer() : undefined;
    const init: RequestInit = { method: c.req.method, headers: new Headers(c.req.raw.headers) };
    if (body !== undefined) init.body = body;
    const upstreamRes = await fetch(url, init);
    const responseBody = await upstreamRes.arrayBuffer();
    const contentType = upstreamRes.headers.get("content-type");
    if (contentType) c.header("content-type", contentType);
    c.status(upstreamRes.status as 200);
    return c.body(responseBody);
}
