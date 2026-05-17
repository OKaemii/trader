import { describe, it, expect } from "vitest";
import {
    MoneySchema,
    Trading,
    Signals,
    MarketData,
    defineContract,
    createInternalCaller,
} from "../index.ts";

describe("schemas", () => {
    it("MoneySchema accepts {amount, currency}", () => {
        const m = MoneySchema.parse({ amount: 100, currency: "GBP" });
        expect(m.currency).toBe("GBP");
    });

    it("MoneySchema rejects unknown currency", () => {
        expect(() => MoneySchema.parse({ amount: 100, currency: "EUR" })).toThrow();
    });

    it("Trading.CashResponseSchema round-trips", () => {
        const r = Trading.CashResponseSchema.parse({
            free:  { amount: 1000, currency: "GBP" },
            total: { amount: 5000, currency: "GBP" },
        });
        expect(r.free.amount).toBe(1000);
    });

    it("Trading.ExecuteOrderRequestSchema validates targetWeight bounds", () => {
        expect(() =>
            Trading.ExecuteOrderRequestSchema.parse({
                signalId: "s1", ticker: "X", action: "BUY",
                targetWeight: 1.5, confidence: 0.5,
            }),
        ).toThrow();
    });

    it("Signals.ExecutedNotificationSchema accepts empty body", () => {
        const r = Signals.ExecutedNotificationSchema.parse({});
        expect(r.at).toBeUndefined();
    });

    it("MarketData.BackfillRequestSchema rejects days > 60", () => {
        expect(() => MarketData.BackfillRequestSchema.parse({ days: 90 })).toThrow();
    });

    it("MarketData.MarketConfigRequestSchema accepts null fields", () => {
        const r = MarketData.MarketConfigRequestSchema.parse({
            barFrequency: null,
            pollIntervalMs: null,
            signalOrderType: null,
        });
        expect(r.barFrequency).toBeNull();
    });
});

describe("contract objects", () => {
    it("Trading.getCashContract carries the path + callerScope", () => {
        expect(Trading.getCashContract.method).toBe("GET");
        expect(Trading.getCashContract.path).toBe("/internal/trading/cash");
        expect(Trading.getCashContract.callerScope).toEqual(["portfolio-service", "signal-service"]);
    });

    it("Signals.markExecutedContract has :id path param", () => {
        expect(Signals.markExecutedContract.path).toBe("/internal/trading/signals/:id/executed");
        expect(Signals.markExecutedContract.callerScope).toEqual(["trading-service"]);
    });
});

describe("createInternalCaller", () => {
    it("round-trips through a fake fetcher with full type inference", async () => {
        const fakeFetch: typeof fetch = async (url, init) => {
            expect(String(url)).toBe("http://trading/internal/trading/cash");
            expect(init?.method).toBe("GET");
            expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer fake-jwt");
            return new Response(JSON.stringify({
                free:  { amount: 100, currency: "GBP" },
                total: { amount: 500, currency: "GBP" },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        };
        const call = createInternalCaller({
            baseUrl: "http://trading",
            callerService: "signal-service",
            mintToken: async () => "fake-jwt",
            fetcher: fakeFetch,
        });
        const cash = await call(Trading.getCashContract);
        // Compile-time check: cash.free.amount is typed as number, not unknown.
        expect(cash.free.amount).toBe(100);
        expect(cash.total.currency).toBe("GBP");
    });

    it("interpolates :param placeholders", async () => {
        const captured: string[] = [];
        const fakeFetch: typeof fetch = async (url) => {
            captured.push(String(url));
            return new Response(JSON.stringify({
                id: "sig-1", executedAt: 123,
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        };
        const call = createInternalCaller({
            baseUrl: "http://signal",
            callerService: "trading-service",
            mintToken: async () => "fake-jwt",
            fetcher: fakeFetch,
        });
        await call(Signals.markExecutedContract, { params: { id: "sig-1" }, body: { at: 123 } });
        expect(captured[0]).toBe("http://signal/internal/trading/signals/sig-1/executed");
    });

    it("throws on non-2xx with status + body in the error", async () => {
        const fakeFetch: typeof fetch = async () =>
            new Response("forbidden", { status: 403 });
        const call = createInternalCaller({
            baseUrl: "http://trading",
            callerService: "x-service",
            mintToken: async () => "fake-jwt",
            fetcher: fakeFetch,
        });
        await expect(call(Trading.getCashContract)).rejects.toThrow(/403/);
    });
});

describe("defineContract", () => {
    it("returns the same shape", () => {
        const c = defineContract({
            method: "POST",
            path: "/x",
            callerScope: ["test"] as const,
        });
        expect(c.method).toBe("POST");
    });
});
