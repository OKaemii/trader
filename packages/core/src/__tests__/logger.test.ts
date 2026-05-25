import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger, ALL_LEVELS } from "../logger.ts";

const origEnv = process.env.LOG_LEVELS;

describe("createLogger", () => {
    let writeSpy: ReturnType<typeof vi.spyOn>;
    let lines: string[];

    beforeEach(() => {
        lines = [];
        writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
            lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
            return true;
        }) as never);
    });

    afterEach(() => {
        writeSpy.mockRestore();
        if (origEnv === undefined) delete process.env.LOG_LEVELS;
        else                       process.env.LOG_LEVELS = origEnv;
    });

    it("exposes the four leveled methods", () => {
        const log = createLogger({ service: "test-service", enabledLevels: ALL_LEVELS });
        for (const m of ["error", "warn", "info", "profile"] as const) {
            expect(typeof log[m]).toBe("function");
        }
    });

    it("defaults to error+warn only — info and profile are suppressed", () => {
        delete process.env.LOG_LEVELS;
        const log = createLogger({ service: "test-service" });
        log.error("err-msg");
        log.warn("warn-msg");
        log.info("info-msg");
        log.profile("profile-msg");
        const combined = lines.join("");
        expect(combined).toContain("err-msg");
        expect(combined).toContain("warn-msg");
        expect(combined).not.toContain("info-msg");
        expect(combined).not.toContain("profile-msg");
    });

    it("honours LOG_LEVELS env allowlist", () => {
        process.env.LOG_LEVELS = "error,info";
        const log = createLogger({ service: "test-service" });
        log.error("err-msg");
        log.warn("warn-msg");
        log.info("info-msg");
        const combined = lines.join("");
        expect(combined).toContain("err-msg");
        expect(combined).not.toContain("warn-msg");
        expect(combined).toContain("info-msg");
    });

    it("explicit enabledLevels takes precedence over env", () => {
        process.env.LOG_LEVELS = "error,warn,info,profile";
        const log = createLogger({ service: "test-service", enabledLevels: ["error"] });
        log.error("err-msg");
        log.warn("warn-msg");
        log.info("info-msg");
        log.profile("profile-msg");
        const combined = lines.join("");
        expect(combined).toContain("err-msg");
        expect(combined).not.toContain("warn-msg");
        expect(combined).not.toContain("info-msg");
        expect(combined).not.toContain("profile-msg");
    });

    it("profile lines are emitted when allowed", () => {
        const log = createLogger({ service: "test-service", enabledLevels: ["profile"] });
        log.profile({ probe: "k3s" }, "health-probe");
        const combined = lines.join("");
        expect(combined).toContain("health-probe");
        expect(combined).toContain("\"probe\":\"k3s\"");
    });
});
