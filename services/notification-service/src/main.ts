import type { RedisClientType } from "redis";
import { createServer, createLogger, listen, registerGracefulShutdown } from "@trader/core";

import { loadNotificationEnv } from "./env.ts";
import { wireDependencies, type NotificationDeps } from "./wiring.ts";
import { createPublicRouter } from "./modules/notifications/routes/public.ts";
import { NotificationLoop } from "./modules/notifications/application/NotificationLoop.ts";
import { AlertConsumer } from "./modules/notifications/application/AlertConsumer.ts";

async function main(): Promise<void> {
    const env    = loadNotificationEnv();
    const logger = createLogger({ service: "notification-service" });
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
        analysisBatcher: deps.analysisBatcher,
    });
    void loop.run().catch((err: unknown) => {
        logger.error({ err }, "notification loop crashed");
        process.exit(1);
    });

    // Operational alerts (G4): subscribe to the `alerts` pub/sub topic and route by tier
    // (critical → webhook + email, warning → email, info → log). Independent of the trade loop.
    const alertConsumer = new AlertConsumer({
        redis: deps.redis as unknown as RedisClientType,
        email: deps.email,
        webhook: deps.webhook,
        alertEmailTo: env.ALERT_EMAIL_TO ?? env.EMAIL_TO,
        logger,
    });
    const stopAlerts = await alertConsumer.start();

    const handle = listen({ app, port: env.PORT, logger });

    registerGracefulShutdown(logger, {
        onSignal: async () => {
            loop.stop();
            stopAlerts();
            // Flush any in-flight analysis batch so the cycle that was mid-collection
            // when SIGTERM arrived still produces its consolidated email.
            if (deps.analysisBatcher) {
                try { await deps.analysisBatcher.drain(); }
                catch (err) { logger.warn({ err }, "analysis batcher drain failed during shutdown"); }
            }
            await handle.close();
            await deps.redis.quit();
        },
    });
}

main().catch((err) => {
    process.stderr.write(`{"level":60,"msg":"[notification-service] fatal startup failure","err":${JSON.stringify(String(err))}}\n`);
    process.exit(1);
});
