import { createServer, createLogger, listen, registerGracefulShutdown } from "@trader/core";

import { loadAuthEnv } from "./env.ts";
import { wireDependencies, type AuthDeps } from "./wiring.ts";
import { createPublicRouter } from "./modules/auth/routes/public.ts";

async function main(): Promise<void> {
    const env    = loadAuthEnv();
    const logger = createLogger({ service: "auth-service", level: env.LOG_LEVEL });
    const deps   = wireDependencies(env, logger);

    const app = await createServer<AuthDeps>({
        service: "auth-service",
        deps,
        pathPrefixes: ["/api/auth", "/admin/api/auth"],
        registerRoutes: (app, d) => {
            app.route("/", createPublicRouter(d.login, d.register, d.users));
        },
        readiness: async () => true,
    });

    // Seed admin from env if provided. Idempotent: skips if the user already exists.
    if (env.SEED_ADMIN_EMAIL && env.SEED_ADMIN_PASSWORD) {
        deps.seedAdmin.execute(env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD)
            .then((r) => logger.info({ email: env.SEED_ADMIN_EMAIL, created: r.created },
                r.created ? "admin seeded" : "admin already exists"))
            .catch((err: unknown) => logger.error({ err, email: env.SEED_ADMIN_EMAIL }, "seed failed"));
    }

    const handle = listen({ app, port: env.PORT, logger });

    registerGracefulShutdown(logger, {
        onSignal: async () => { await handle.close(); },
    });
}

main().catch((err) => {
    process.stderr.write(`{"level":60,"msg":"[auth-service] fatal startup failure","err":${JSON.stringify(String(err))}}\n`);
    process.exit(1);
});
