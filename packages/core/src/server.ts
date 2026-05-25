import { Hono } from "hono";
import type { Logger } from "./logger.ts";
import { errorHandler } from "./errors.ts";

export interface ServerConfig<Deps extends { logger: Logger }> {
    service: string;
    deps: Deps;
    registerRoutes: (app: Hono, deps: Deps) => void | Promise<void>;
    /** Readiness probe — returns true when downstream deps are reachable. */
    readiness?: (deps: Deps) => Promise<boolean>;
    /**
     * Extra path prefixes under which `/health` should be exposed as an alias. The portal's
     * fan-out aggregator probes services via nginx-ingress on their public prefix
     * (`/api/<svc>/health`, `/admin/api/<svc>/health`); the ingress doesn't strip prefix,
     * so the service has to register handlers at every alias.
     * Example: `pathPrefixes: ['/api/portfolio', '/admin/api/portfolio']`.
     */
    pathPrefixes?: readonly string[];
}

export async function createServer<Deps extends { logger: Logger }>(
    cfg: ServerConfig<Deps>,
): Promise<Hono> {
    const app = new Hono();

    const healthOk = (c: import("hono").Context) => c.json({ status: "ok", service: cfg.service });
    const readinessHandler = async (c: import("hono").Context) => {
        const ok = cfg.readiness ? await cfg.readiness(cfg.deps).catch(() => false) : true;
        return c.json({ status: ok ? "ok" : "not_ready" }, ok ? 200 : 503);
    };

    // Liveness: process up. Readiness: deps reachable.
    app.get("/health",       healthOk);
    app.get("/health/live",  healthOk);
    app.get("/health/ready", readinessHandler);

    // Prefix-aliased health endpoints for the portal fan-out (nginx-ingress doesn't
    // strip prefix, so the service has to expose /health at every public prefix).
    for (const prefix of cfg.pathPrefixes ?? []) {
        app.get(`${prefix}/health`,       healthOk);
        app.get(`${prefix}/health/ready`, readinessHandler);
    }

    await cfg.registerRoutes(app, cfg.deps);
    app.onError(errorHandler(cfg.deps.logger));
    return app;
}
