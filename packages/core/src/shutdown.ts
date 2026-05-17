import type { Logger } from "pino";

export interface ShutdownHooks {
    onSignal: () => Promise<void> | void;
    timeoutMs?: number;
}

export function registerGracefulShutdown(logger: Logger, hooks: ShutdownHooks): void {
    const timeout = hooks.timeoutMs ?? 10_000;
    let triggered = false;
    const shutdown = (signal: string): void => {
        if (triggered) return;
        triggered = true;
        logger.info({ signal }, "shutdown initiated");
        const force = setTimeout(() => {
            logger.error({ timeoutMs: timeout }, "shutdown timeout — forcing exit");
            process.exit(1);
        }, timeout);
        force.unref();
        Promise.resolve()
            .then(() => hooks.onSignal())
            .then(() => {
                clearTimeout(force);
                process.exit(0);
            })
            .catch((err: unknown) => {
                logger.error({ err }, "shutdown failed");
                process.exit(1);
            });
    };
    process.on("SIGTERM", () => { shutdown("SIGTERM"); });
    process.on("SIGINT", () => { shutdown("SIGINT"); });
}
