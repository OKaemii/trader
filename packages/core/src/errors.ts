import type { Context } from "hono";
import type { Logger } from "./logger.ts";

export type AppErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;

export class AppError extends Error {
    readonly code: string;
    readonly status: AppErrorStatus;
    readonly details: unknown;

    constructor(code: string, status: AppErrorStatus, details?: unknown, cause?: unknown) {
        super(code);
        this.code = code;
        this.status = status;
        this.details = details;
        if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    }
}

export function errorHandler(log: Logger) {
    return (err: Error, c: Context): Response => {
        if (err instanceof AppError) {
            log.warn({ code: err.code, status: err.status, details: err.details, path: c.req.path }, "AppError");
            return c.json({ error: err.code, details: err.details ?? null }, err.status);
        }
        log.error({ err: { name: err.name, message: err.message, stack: err.stack }, path: c.req.path }, "Unhandled error");
        return c.json({ error: "InternalServerError" }, 500);
    };
}
