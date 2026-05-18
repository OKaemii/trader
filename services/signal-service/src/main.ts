import { createServer, createLogger, listen, registerGracefulShutdown } from "@trader/core";
import { startTracer, traceMixin } from "@trader/telemetry";

import { loadSignalEnv } from "./env.ts";
import { wireDependencies, type SignalDeps } from "./wiring.ts";
import { createRouter } from "./modules/signals/routes/public.ts";
import { createInternalRouter } from "./modules/signals/routes/internal.ts";

async function main(): Promise<void> {
    const env    = loadSignalEnv();
    // Tracer first — must boot before any auto-instrumented HTTP / DB clients are loaded.
    // No-op when OTLP_ENDPOINT is unset (dev / homeserver without collector).
    startTracer({ service: "signal-service", otlpEndpoint: env.OTLP_ENDPOINT });
    const logger = createLogger({ service: "signal-service", level: env.LOG_LEVEL, traceMixin });
    const deps   = await wireDependencies(env, logger);

    const app = await createServer<SignalDeps>({
        service: "signal-service",
        deps,
        registerRoutes: (app, d) => {
            app.route("/", createRouter({
                findRecent: d.findRecent,
                approveSignal: d.approveSignal,
                getProgress: d.getProgress,
                autoApprovalGate: d.autoApprovalGate,
                signalRepo: d.signalRepo,
            }));
            app.route("/", createInternalRouter({
                findRecent: d.findRecent,
                approveSignal: d.approveSignal,
                riskEngine: d.riskEngine,
                signalRepo: d.signalRepo,
                publisher: d.publisher,
                logger: d.logger,
            }));

            // Prometheus metrics — preserved verbatim from the legacy index.ts.
            app.get("/metrics", async (c) => {
                try {
                    const health = (await d.redis.get("strategy:health")) ?? "unknown";
                    const score  = ({ healthy: 1, warning: 0.75, degraded: 0.25, suspended: 0 } as Record<string, number>)[health] ?? -1;
                    const m = await d.decayMonitor.getLastMetrics();
                    const lines = [
                        "# HELP strategy_health_score Health state (1=healthy 0.75=warning 0.25=degraded 0=suspended)",
                        "# TYPE strategy_health_score gauge",
                        `strategy_health_score ${score}`,
                        "# HELP strategy_rolling_sharpe_30d Rolling 30-day Sharpe ratio",
                        "# TYPE strategy_rolling_sharpe_30d gauge",
                        `strategy_rolling_sharpe_30d ${m?.rollingSharpe30d ?? 0}`,
                        "# HELP strategy_hit_rate_30d 30-day signal hit rate",
                        "# TYPE strategy_hit_rate_30d gauge",
                        `strategy_hit_rate_30d ${m?.hitRate30d ?? 0}`,
                        "# HELP strategy_turnover_ratio Turnover ratio vs weekly budget",
                        "# TYPE strategy_turnover_ratio gauge",
                        `strategy_turnover_ratio ${m?.turnoverRatio ?? 0}`,
                        "# HELP strategy_ic_tstat IC t-statistic",
                        "# TYPE strategy_ic_tstat gauge",
                        `strategy_ic_tstat ${m?.icTStat ?? 0}`,
                        "# HELP strategy_feature_drift_kl Feature KL divergence from training baseline",
                        "# TYPE strategy_feature_drift_kl gauge",
                        `strategy_feature_drift_kl ${m?.featureDriftKL ?? 0}`,
                    ];
                    return new Response(lines.join("\n") + "\n", {
                        headers: { "Content-Type": "text/plain; version=0.0.4" },
                    });
                } catch {
                    return new Response("# metrics unavailable\n", { headers: { "Content-Type": "text/plain" } });
                }
            });
        },
        readiness: async (d) => { await d.db.command({ ping: 1 }); return true; },
    });

    // Subscribe to strategy-engine output stream. Fire-and-forget — the subscriber owns its
    // own loop and ack semantics.
    void deps.subscriber.subscribe(async (features) => { await deps.generateSignals.execute(features); });

    // Cross-service invalidation: drop our derived caches when market-data publishes.
    await deps.bus.subscribe("market", async () => { await deps.cache.invalidatePattern("*"); });

    const handle = listen({ app, port: env.PORT, logger });

    registerGracefulShutdown(logger, {
        onSignal: async () => {
            await handle.close();
            await deps.redis.quit();
        },
    });
}

main().catch((err) => {
    // Logger isn't constructed yet at this catch — fall back to stderr.
    process.stderr.write(`{"level":60,"msg":"[signal-service] fatal startup failure","err":${JSON.stringify(String(err))}}\n`);
    process.exit(1);
});
