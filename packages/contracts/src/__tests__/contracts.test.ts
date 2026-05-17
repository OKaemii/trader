import { describe, it, expect } from "vitest";
import {
    MoneySchema,
    CashResponseSchema,
    ExecuteOrderRequestSchema,
    ExecutedNotificationSchema,
    BackfillRequestSchema,
    MarketConfigRequestSchema,
} from "../index.ts";

describe("contracts", () => {
    it("MoneySchema accepts {amount, currency}", () => {
        const m = MoneySchema.parse({ amount: 100, currency: "GBP" });
        expect(m.currency).toBe("GBP");
    });

    it("MoneySchema rejects unknown currency", () => {
        expect(() => MoneySchema.parse({ amount: 100, currency: "EUR" })).toThrow();
    });

    it("CashResponseSchema round-trips", () => {
        const r = CashResponseSchema.parse({
            free:  { amount: 1000, currency: "GBP" },
            total: { amount: 5000, currency: "GBP" },
        });
        expect(r.free.amount).toBe(1000);
    });

    it("ExecuteOrderRequestSchema validates targetWeight bounds", () => {
        expect(() =>
            ExecuteOrderRequestSchema.parse({
                signalId: "s1", ticker: "X", action: "BUY",
                targetWeight: 1.5, confidence: 0.5,
            }),
        ).toThrow();
    });

    it("ExecutedNotificationSchema accepts empty body", () => {
        const r = ExecutedNotificationSchema.parse({});
        expect(r.at).toBeUndefined();
    });

    it("BackfillRequestSchema rejects days > 60", () => {
        expect(() => BackfillRequestSchema.parse({ days: 90 })).toThrow();
    });

    it("MarketConfigRequestSchema accepts null fields", () => {
        const r = MarketConfigRequestSchema.parse({
            barFrequency: null,
            pollIntervalMs: null,
            signalOrderType: null,
        });
        expect(r.barFrequency).toBeNull();
    });
});
