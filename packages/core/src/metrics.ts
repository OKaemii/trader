import { Registry, collectDefaultMetrics } from "prom-client";
import type { Hono } from "hono";

// Shared Prometheus registry for every TS service. `collectDefaultMetrics` provides the Node
// runtime baseline (heap, GC pauses, event-loop lag, CPU, open FDs) — the DevOps essentials.
// Services can register their own Counter/Gauge/Histogram on this registry for business metrics
// (orders placed, T212 429s, queue depth, …) and they'll appear on the same /metrics endpoint.
export const metricsRegistry = new Registry();

let _defaultsStarted = false;

/** Start default-metric collection once per process (idempotent). */
export function startDefaultMetrics(): void {
    if (_defaultsStarted) return;
    _defaultsStarted = true;
    collectDefaultMetrics({ register: metricsRegistry });
}

/**
 * Mount `GET /metrics` (Prometheus text exposition) on a Hono app. Called from `listen()` so every
 * service that uses the shared server entry is scraped automatically. Unauthenticated by design:
 * it's reached in-cluster via the Service (ServiceMonitor), never through the public ingress.
 */
export function mountMetrics(app: Hono): void {
    startDefaultMetrics();
    app.get("/metrics", async (c) => {
        const body = await metricsRegistry.metrics();
        return c.body(body, 200, { "Content-Type": metricsRegistry.contentType });
    });
}
