import { Hono } from "hono";
import { requireAuth } from "@trader/shared-auth";
import { proxy } from "../proxy.ts";

export function createAuthedRouter(): Hono {
    const authed = new Hono();
    authed.use("*", requireAuth);

    authed.get("/api/signals",          (c) => proxy("http://signal-service:3003", c));
    // Specific path must come before the :id catch-all so it isn't shadowed.
    authed.get("/api/signals/progress", (c) => proxy("http://signal-service:3003", c));
    authed.get("/api/signals/:id",      (c) => proxy("http://signal-service:3003", c));
    authed.get("/api/portfolio",     (c) => proxy("http://portfolio-service:3006", c));
    authed.get("/api/portfolio/pnl", (c) => proxy("http://portfolio-service:3006", c));
    return authed;
}
