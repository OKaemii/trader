import type { Context } from "hono";
import { mintInternalJwt } from "@trader/shared-auth";

/**
 * HTTP proxy helper. Forwards the inbound request to `upstream` with the path + query
 * intact, attaches a short-lived audience='internal' JWT (sub='api-gateway'), and unwraps
 * the upstream response into Hono's mutable-headered Response so downstream cors middleware
 * can mutate headers without crashing on `TypeError: immutable`.
 */
export async function proxy(upstream: string, c: Context): Promise<Response> {
    const path = c.req.path;
    const qs = c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : "";
    const url = `${upstream}${path}${qs}`;
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    // Node's fetch (undici) rejects streamed request bodies without `duplex: 'half'`.
    // Buffer the body up front so undici sees plain bytes.
    const body = hasBody ? await c.req.raw.arrayBuffer() : undefined;
    const headers = await withInternalHeaders(new Headers(c.req.raw.headers));
    const init: RequestInit = { method: c.req.method, headers };
    if (body !== undefined) init.body = body;
    const upstreamRes = await fetch(url, init);
    const responseBody = await upstreamRes.arrayBuffer();
    const contentType = upstreamRes.headers.get("content-type");
    if (contentType) c.header("content-type", contentType);
    c.status(upstreamRes.status as 200);
    return c.body(responseBody);
}

async function withInternalHeaders(headers: Headers): Promise<Headers> {
    const out = new Headers(headers);
    const jwt = await mintInternalJwt("api-gateway");
    out.set("Authorization", `Bearer ${jwt}`);
    return out;
}
