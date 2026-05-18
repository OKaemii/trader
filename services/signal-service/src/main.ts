import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createLogger, registerGracefulShutdown, errorHandler } from "@trader/core";
import { startTracer, traceMixin } from "@trader/telemetry";

import { loadSignalEnv } from "./env.ts";
import { wireDependencies } from "./wiring.ts";
import { createRouter } from "./modules/signals/routes/public.ts";
import { createInternalRouter } from "./modules/signals/routes/internal.ts";
import { registerTopologyWebSocket, registerSystemReset } from "./modules/signals/routes/system.ts";

async function main(): Promise<void> {
    const env    = loadSignalEnv();
    startTracer({ service: "signal-service", otlpEndpoint: env.OTLP_ENDPOINT });
    const logger = createLogger({ service: "signal-service", level: env.LOG_LEVEL, traceMixin });
    const deps   = await wireDependencies(env, logger);

    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

    const healthOk = (c: import("hono").Context) => c.json({ status: "ok", service: "signal-service" });
    app.get("/health",                  healthOk);
    app.get("/health/live",             healthOk);
    app.get("/api/signals/health",      healthOk);
    app.get("/admin/api/signals/health", healthOk);
    app.get("/health/ready", async (c) => {
        try { await deps.db.command({ ping: 1 }); return c.json({ status: "ok" }); }
        catch { return c.json({ status: "not_ready" }, 503); }
    });

    app.route("/", createRouter({
        findRecent:       deps.findRecent,
        approveSignal:    deps.approveSignal,
        getProgress:      deps.getProgress,
        autoApprovalGate: deps.autoApprovalGate,
        signalRepo:       deps.signalRepo,
        riskEngine:       deps.riskEngine,
    }));
    app.route("/", createInternalRouter({
        signalRepo: deps.signalRepo,
        publisher:  deps.publisher,
        logger:     deps.logger,
    }));

    // WebSocket + system-reset moved here from the (deleted) api-gateway. Both belong
    // with the service that already owns the strategy:* pubsub channels and the bulk of
    // the derived-state collections.
    registerTopologyWebSocket(app, upgradeWebSocket);
    registerSystemReset(app, logger);

    // Prometheus metrics — preserved verbatim from the legacy index.ts.
    app.get("/metrics", async (c) => {
        try {
            const health = (await deps.redis.get("strategy:health")) ?? "unknown";
            const score  = ({ healthy: 1, warning: 0.75, degraded: 0.25, suspended: 0 } as Record<string, number>)[health] ?? -1;
            const m = await deps.decayMonitor.getLastMetrics();
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

    app.onError(errorHandler(logger));

    for (const sub of deps.subscribers) {
        void sub.subscribe(async (features) => { await deps.generateSignals.execute(features); });
    }
    await deps.bus.subscribe("market", async () => { await deps.cache.invalidatePattern("*"); });

    // Self-heal stuck Pending signals. See AutoApprovalGate.startSweeper for the rationale.
    const stopSweeper = deps.autoApprovalGate.startSweeper(env.AUTO_APPROVE_SWEEP_INTERVAL_MS);

    const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
        logger.info({ port: info.port }, "signal-service listening");
    });
    injectWebSocket(server);

    registerGracefulShutdown(logger, {
        onSignal: async () => {
            stopSweeper();
            await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
            await deps.redis.quit();
        },
    });
}

main().catch((err) => {
    process.stderr.write(`{"level":60,"msg":"[signal-service] fatal startup failure","err":${JSON.stringify(String(err))}}\n`);
    process.exit(1);
});
