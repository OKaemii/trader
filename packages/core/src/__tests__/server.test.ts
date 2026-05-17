import { describe, it, expect, vi } from "vitest";
import { createServer } from "../server.ts";

const stubLogger = () => ({
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
});

describe("createServer", () => {
    it("exposes /health/live, /health/ready, and /health", async () => {
        const log = stubLogger();
        const app = await createServer({
            service: "x",
            deps: { logger: log as never },
            registerRoutes: () => { /* no extra routes */ },
        });
        for (const path of ["/health/live", "/health/ready", "/health"]) {
            const res = await app.request(path);
            expect(res.status).toBe(200);
        }
    });

    it("returns 503 from /health/ready when readiness fails", async () => {
        const log = stubLogger();
        const app = await createServer({
            service: "x",
            deps: { logger: log as never },
            registerRoutes: () => { /* none */ },
            readiness: async () => false,
        });
        const res = await app.request("/health/ready");
        expect(res.status).toBe(503);
        const body = await res.json() as { status: string };
        expect(body.status).toBe("not_ready");
    });

    it("returns 503 from /health/ready when readiness throws", async () => {
        const log = stubLogger();
        const app = await createServer({
            service: "x",
            deps: { logger: log as never },
            registerRoutes: () => { /* none */ },
            readiness: async () => { throw new Error("db unreachable"); },
        });
        const res = await app.request("/health/ready");
        expect(res.status).toBe(503);
    });
});
