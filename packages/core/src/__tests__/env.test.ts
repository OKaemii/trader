import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { loadEnv } from "../env.ts";

describe("loadEnv", () => {
    it("returns parsed values on success", () => {
        const schema = z.object({
            FOO: z.string(),
            COUNT: z.coerce.number().int(),
        });
        const env = loadEnv(schema, { source: { FOO: "bar", COUNT: "42" } });
        expect(env.FOO).toBe("bar");
        expect(env.COUNT).toBe(42);
    });

    it("calls onFatal with the issue list on failure", () => {
        const schema = z.object({
            FOO: z.string(),
        });
        const onFatal = vi.fn((_issues) => { throw new Error("fatal"); }) as never;
        expect(() => loadEnv(schema, { source: { /* FOO missing */ }, onFatal })).toThrow("fatal");
        expect((onFatal as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1);
        const issues = (onFatal as unknown as { mock: { calls: Array<[ReadonlyArray<{ path: string[]; message: string }>]> } }).mock.calls[0]![0];
        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0]!.path).toEqual(["FOO"]);
    });
});
