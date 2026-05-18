import { Hono } from "hono";
import { proxy } from "../infrastructure/proxy.ts";

export function createPublicRouter(): Hono {
    const app = new Hono();
    app.post("/api/auth/login",    (c) => proxy("http://auth-service:3001", c));
    app.post("/api/auth/register", (c) => proxy("http://auth-service:3001", c));
    app.post("/api/auth/refresh",  (c) => proxy("http://auth-service:3001", c));
    app.get("/api/market/live",    (c) => proxy("http://market-data-service:3002", c));
    return app;
}
