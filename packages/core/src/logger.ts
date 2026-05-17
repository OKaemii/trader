import pino, { type Logger } from "pino";

export interface LoggerConfig {
    service: string;
    level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    /** Mixin called per log line — typically returns { traceId, spanId } from OTel. */
    traceMixin?: () => Record<string, unknown>;
}

export function createLogger(cfg: LoggerConfig): Logger {
    const options: pino.LoggerOptions = {
        name: cfg.service,
        level: cfg.level ?? (process.env.LOG_LEVEL as LoggerConfig["level"]) ?? "info",
        redact: {
            paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "*.password",
                "*.apiKey",
                "*.apiKeyId",
            ],
            remove: true,
        },
    };
    if (cfg.traceMixin) options.mixin = cfg.traceMixin;
    return pino(options);
}

export type { Logger };
