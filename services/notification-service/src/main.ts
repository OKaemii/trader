import type { RedisClientType } from "redis";
import { createServer, createLogger, listen, registerGracefulShutdown } from "@trader/core";

import { loadNotificationEnv } from "./env.ts";
import { wireDependencies, type NotificationDeps } from "./wiring.ts";
import { createPublicRouter } from "./modules/notifications/routes/public.ts";
import { NotificationLoop } from "./modules/notifications/application/NotificationLoop.ts";

async function main(): Promise<void> {
    const env    = loadNotificationEnv();
    const logger = createLogger({ service: "notification-service", level: env.LOG_LEVEL });
    const deps   = await wireDependencies(env, logger);

    const app = await createServer<NotificationDeps>({
        service: "notification-service",
        deps,
        pathPrefixes: ["/api/notifications"],
        registerRoutes: (app, d) => {
            app.route("/", createPublicRouter(d));
        },
        readiness: async () => true,
    });

    const loop = new NotificationLoop({
        redis: deps.redis as unknown as RedisClientType,
        consumerName: `notification-service-${env.POD_NAME}`,
        email: deps.email,
        push: deps.push,
        logger,
    });
    void loop.run().catch((err: unknown) => {
        logger.error({ err }, "notification loop crashed");
        process.exit(1);
    });

    const handle = listen({ app, port: env.PORT, logger });

    registerGracefulShutdown(logger, {
        onSignal: async () => {
            loop.stop();
            await handle.close();
            await deps.redis.quit();
        },
    });
}

main().catch((err) => {
    process.stderr.write(`{"level":60,"msg":"[notification-service] fatal startup failure","err":${JSON.stringify(String(err))}}\n`);
    process.exit(1);
});
