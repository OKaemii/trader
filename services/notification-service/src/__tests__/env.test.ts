import { describe, it, expect } from "vitest";
import { EnvSchema } from "../env.ts";

// Regression for the CrashLoopBackOff that stalled the helm deploy: k8s Secrets inject a
// present-but-blank key as "" (not undefined), and `z.string().url()/.email().optional()`
// rejects "" → process exits on boot. Blank optional secrets must mean "disabled".
describe("notification env schema — blank optional secrets", () => {
  it("treats blank URL/email secrets as undefined (disabled), not validation errors", () => {
    const env = EnvSchema.parse({
      ALERT_WEBHOOK_URL: "",
      ALERT_EMAIL_TO: "",
      EMAIL_FROM: "",
      EMAIL_TO: "",
      OTLP_ENDPOINT: "   ",   // whitespace-only is also blank
    });
    expect(env.ALERT_WEBHOOK_URL).toBeUndefined();
    expect(env.ALERT_EMAIL_TO).toBeUndefined();
    expect(env.EMAIL_FROM).toBeUndefined();
    expect(env.EMAIL_TO).toBeUndefined();
    expect(env.OTLP_ENDPOINT).toBeUndefined();
  });

  it("still rejects a genuinely malformed (non-blank) URL or email", () => {
    expect(() => EnvSchema.parse({ ALERT_WEBHOOK_URL: "not-a-url" })).toThrow();
    expect(() => EnvSchema.parse({ ALERT_EMAIL_TO: "not-an-email" })).toThrow();
  });

  it("preserves valid values", () => {
    const env = EnvSchema.parse({
      ALERT_WEBHOOK_URL: "https://hooks.example.com/abc",
      ALERT_EMAIL_TO: "ops@example.com",
    });
    expect(env.ALERT_WEBHOOK_URL).toBe("https://hooks.example.com/abc");
    expect(env.ALERT_EMAIL_TO).toBe("ops@example.com");
  });
});
