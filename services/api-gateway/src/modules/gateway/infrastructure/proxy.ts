import type { Context } from "hono";
import { mintInternalJwt } from "@trader/shared-auth";

/**
 * HTTP proxy helper. The gateway is the only edge that sees a user JWT — it authorises
 * the request (requireAuth / requireRole('admin')) and then swaps the Authorization
 * header for a freshly minted internal JWT (sub='api-gateway', aud='internal') before
 * forwarding to the downstream service. Downstream services gate their `/api/*` routes
 * with `requireInternal + requireCaller('api-gateway')` — they never inspect a user JWT
 * directly; trust flows by service identity, not by user identity.
 *
 * Response side: we unwrap the upstream Response into Hono's mutable-headered Response
 * so downstream cors middleware can mutate headers without crashing on `TypeError:
 * immutable`.
 */
export async function proxy(upstream: string, c: Context): Promise<Response> {
    const path = c.req.path;
    const qs = c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : "";
    const url = `${upstream}${path}${qs}`;
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    // Node's fetch (undici) rejects streamed request bodies without `duplex: 'half'`.
    // Buffer the body up front so undici sees plain bytes.
    const body = hasBody ? await c.req.raw.arrayBuffer() : undefined;
    const headers = new Headers(c.req.raw.headers);
    headers.set("Authorization", `Bearer ${await mintInternalJwt("api-gateway")}`);
    const init: RequestInit = { method: c.req.method, headers };
    if (body !== undefined) init.body = body;
    const upstreamRes = await fetch(url, init);
    const responseBody = await upstreamRes.arrayBuffer();
    const contentType = upstreamRes.headers.get("content-type");
    if (contentType) c.header("content-type", contentType);
    c.status(upstreamRes.status as 200);
    return c.body(responseBody);
}
