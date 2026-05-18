// Module-local logger reference. main.ts sets this with the wired Pino logger before
// importing index.ts; legacy module-scope code in index.ts uses `log` directly. Once
// the index.ts module-scope wiring is fully unwound into wiring.ts, this shim goes
// away. Until then, `log` exposes a console-like flexible signature that adapts the
// existing call sites to Pino's (object, msg) shape without rewriting every call.

import type { Logger } from "@trader/core";

let _logger: Logger | null = null;

export function setLogger(logger: Logger): void {
    _logger = logger;
}

function emit(level: "info" | "warn" | "error" | "fatal" | "debug" | "trace", args: unknown[]): void {
    if (_logger) {
        // Pino's methods read `this[msgPrefixSym]` internally, so we must call them
        // bound to the logger — `const fn = logger.info; fn(...)` breaks at runtime.
        // Heuristic: if the first arg is an object (Pino convention), pass through.
        // Otherwise treat everything as msg + ctx — wrap the trailing values into a `ctx` field.
        const [first, ...rest] = args;
        const logger = _logger as unknown as Record<string, (...a: unknown[]) => void>;
        if (typeof first === "object" && first !== null) {
            logger[level]!(...args);
        } else {
            const msg = typeof first === "string" ? first : String(first);
            if (rest.length === 0) {
                logger[level]!(msg);
            } else {
                const ctx: Record<string, unknown> = {};
                rest.forEach((v, i) => { ctx[`arg${i}`] = v; });
                logger[level]!(ctx, msg);
            }
        }
        return;
    }
    // Fallback: route through console so pre-wiring boot messages aren't lost.
    const fn = level === "warn" || level === "error" || level === "fatal" ? console.warn : console.log;
    fn("[market-data]", ...args);
}

export const log = {
    info:  (...args: unknown[]) => emit("info",  args),
    warn:  (...args: unknown[]) => emit("warn",  args),
    error: (...args: unknown[]) => emit("error", args),
    fatal: (...args: unknown[]) => emit("fatal", args),
    debug: (...args: unknown[]) => emit("debug", args),
    trace: (...args: unknown[]) => emit("trace", args),
};
