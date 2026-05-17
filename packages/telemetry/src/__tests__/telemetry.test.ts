import { describe, it, expect } from "vitest";
import { startTracer, traceMixin } from "../index.ts";

describe("@trader/telemetry", () => {
    it("startTracer returns null without otlpEndpoint", () => {
        expect(startTracer({ service: "x" })).toBeNull();
    });

    it("traceMixin returns {} when no span is active", () => {
        expect(traceMixin()).toEqual({});
    });
});
