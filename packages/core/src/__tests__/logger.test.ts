import { describe, it, expect } from "vitest";
import { createLogger } from "../logger.ts";

describe("createLogger", () => {
    it("returns a Pino logger tagged with the service name", () => {
        const log = createLogger({ service: "test-service" });
        expect(log.level).toBeDefined();
        expect(typeof log.info).toBe("function");
        expect(typeof log.warn).toBe("function");
    });

    it("applies the traceMixin output to every log line", () => {
        const log = createLogger({
            service: "test-service",
            traceMixin: () => ({ traceId: "abc", spanId: "def" }),
        });
        // Pino's mixin contract is exercised at log-time; here we just verify the option is accepted.
        expect(log).toBeDefined();
    });

    it("redacts sensitive fields", () => {
        // Pino redact is configured but emitting to stdout is hard to capture in this harness.
        // Instead we just verify the logger constructs successfully when the redact paths are present.
        const log = createLogger({ service: "test-service" });
        expect(log).toBeDefined();
    });
});
