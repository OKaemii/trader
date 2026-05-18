import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createLogger, registerGracefulShutdown } from "@trader/core";

import { loadGatewayEnv } from "./env.ts";
import { createPublicRouter } from "./modules/gateway/routes/public.ts";
import { createAuthedRouter } from "./modules/gateway/routes/authed.ts";
import { createAdminRouter } from "./modules/gateway/routes/admin.ts";
import { registerWebSockets } from "./modules/gateway/routes/websocket.ts";

async function main(): Promise<void> {
    const env    = loadGatewayEnv();
    const logger = createLogger({ service: "api-gateway", level: env.LOG_LEVEL });

    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

    app.use("*", cors({ origin: env.CORS_ORIGINS.split(",").map((s) => s.trim()) }));

    app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

    app.route("/", createPublicRouter());
    registerWebSockets(app, upgradeWebSocket);
    app.route("/", createAuthedRouter());
    app.route("/", createAdminRouter(logger));

    const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
        logger.info({ port: info.port }, "api-gateway listening");
    });
    injectWebSocket(server);

    registerGracefulShutdown(logger, {
        onSignal: async () => new Promise<void>((resolve, reject) => {
            server.close((err) => err ? reject(err) : resolve());
        }),
    });
}

main().catch((err) => {
    process.stderr.write(`{"level":60,"msg":"[api-gateway] fatal startup failure","err":${JSON.stringify(String(err))}}\n`);
    process.exit(1);
});
