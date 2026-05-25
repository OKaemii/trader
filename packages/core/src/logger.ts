import pino from "pino";

// Application-facing log levels. Existing call sites already use only error/warn/info;
// `profile` is the new low-importance tier — diagnostics that prove the system is
// alive (heartbeats, health probes, idle ticks) but bury the signal when always-on.
export type LogLevel = "error" | "warn" | "info" | "profile";

export const ALL_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "profile"];

export interface Logger {
    error(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    info(...args: unknown[]): void;
    profile(...args: unknown[]): void;
}

export interface LoggerConfig {
    service: string;
    /**
     * Allowlist of levels to emit. If omitted, parsed from LOG_LEVELS env
     * (comma-separated, e.g. `error,warn,info`). Default when neither is set:
     * `error` + `warn` only — `info` and `profile` are dropped.
     */
    enabledLevels?: readonly LogLevel[];
    /** Mixin called per log line — typically returns { traceId, spanId } from OTel. */
    traceMixin?: () => Record<string, unknown>;
}

function parseLevelsEnv(raw: string | undefined): readonly LogLevel[] | undefined {
    if (!raw) return undefined;
    const valid = new Set<string>(ALL_LEVELS);
    const out = raw.split(",").map((s) => s.trim()).filter((s) => valid.has(s)) as LogLevel[];
    return out.length > 0 ? out : undefined;
}

export function createLogger(cfg: LoggerConfig): Logger {
    const enabled = new Set<LogLevel>(
        cfg.enabledLevels ?? parseLevelsEnv(process.env.LOG_LEVELS) ?? ["error", "warn"],
    );

    const options: pino.LoggerOptions = {
        name: cfg.service,
        // The wrapper does its own gating; tell pino to pass everything through so
        // we don't double-filter. `profile` rides on pino's `trace` numeric slot.
        level: "trace",
        customLevels: { profile: 15 },
        useOnlyCustomLevels: false,
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

    const base = pino(options) as pino.Logger & { profile(...args: unknown[]): void };
    const noop = (): void => {};
    const forward = (level: LogLevel) => {
        if (!enabled.has(level)) return noop;
        const fn = base[level].bind(base);
        return (...args: unknown[]): void => { (fn as (...a: unknown[]) => void)(...args); };
    };

    return {
        error:   forward("error"),
        warn:    forward("warn"),
        info:    forward("info"),
        profile: forward("profile"),
    };
}
