import { Hono } from "hono";
import type { Logger } from "pino";
import { errorHandler } from "./errors.ts";

export interface ServerConfig<Deps extends { logger: Logger }> {
    service: string;
    deps: Deps;
    registerRoutes: (app: Hono, deps: Deps) => void | Promise<void>;
    /** Readiness probe — returns true when downstream deps are reachable. */
    readiness?: (deps: Deps) => Promise<boolean>;
}

export async function createServer<Deps extends { logger: Logger }>(
    cfg: ServerConfig<Deps>,
): Promise<Hono> {
    const app = new Hono();

    // Liveness: process up. Readiness: deps reachable.
    app.get("/health/live", (c) => c.json({ status: "ok", service: cfg.service }));
    app.get("/health/ready", async (c) => {
        const ok = cfg.readiness ? await cfg.readiness(cfg.deps).catch(() => false) : true;
        return c.json({ status: ok ? "ok" : "not_ready" }, ok ? 200 : 503);
    });
    // Back-compat alias for kube probes still hitting /health.
    app.get("/health", (c) => c.json({ status: "ok", service: cfg.service }));

    await cfg.registerRoutes(app, cfg.deps);
    app.onError(errorHandler(cfg.deps.logger));
    return app;
}
