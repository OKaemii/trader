import { createServer, createLogger, listen, registerGracefulShutdown } from "@trader/core";

import { loadPortfolioEnv } from "./env.ts";
import { wireDependencies, type PortfolioDeps } from "./wiring.ts";
import { createPublicRouter } from "./modules/positions/routes/public.ts";

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
    const env    = loadPortfolioEnv();
    const logger = createLogger({ service: "portfolio-service", level: env.LOG_LEVEL });
    const deps   = await wireDependencies(env, logger);

    const app = await createServer<PortfolioDeps>({
        service: "portfolio-service",
        deps,
        pathPrefixes: ["/api/portfolio"],
        registerRoutes: (app, d) => {
            app.route("/", createPublicRouter(d));
        },
        readiness: async (d) => { await d.db.command({ ping: 1 }); return true; },
    });

    // 5-minute position sync loop. Returns a stop fn used by graceful-shutdown.
    const stopSync = deps.syncService.start(SYNC_INTERVAL_MS);

    const handle = listen({ app, port: env.PORT, logger });

    registerGracefulShutdown(logger, {
        onSignal: async () => {
            stopSync();
            await handle.close();
            await deps.redis.quit();
        },
    });
}

main().catch((err) => {
    process.stderr.write(`{"level":60,"msg":"[portfolio-service] fatal startup failure","err":${JSON.stringify(String(err))}}\n`);
    process.exit(1);
});
