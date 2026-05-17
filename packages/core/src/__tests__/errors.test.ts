import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { AppError, errorHandler } from "../errors.ts";

const stubLogger = () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
});

describe("AppError + errorHandler", () => {
    it("maps AppError to its status with code + details payload", async () => {
        const log = stubLogger();
        const app = new Hono();
        app.get("/x", () => { throw new AppError("BadThing", 422, { field: "ticker" }); });
        app.onError(errorHandler(log as never));

        const res = await app.request("/x");
        expect(res.status).toBe(422);
        const body = await res.json() as { error: string; details: { field: string } };
        expect(body.error).toBe("BadThing");
        expect(body.details).toEqual({ field: "ticker" });
        expect(log.warn).toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
    });

    it("maps unknown Error to 500 with InternalServerError", async () => {
        const log = stubLogger();
        const app = new Hono();
        app.get("/x", () => { throw new Error("oops"); });
        app.onError(errorHandler(log as never));

        const res = await app.request("/x");
        expect(res.status).toBe(500);
        const body = await res.json() as { error: string };
        expect(body.error).toBe("InternalServerError");
        expect(log.error).toHaveBeenCalled();
    });
});
