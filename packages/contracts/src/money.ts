import { z } from "zod";

export const CurrencySchema = z.enum(["GBP", "USD"]);
export type Currency = z.infer<typeof CurrencySchema>;

export const MoneySchema = z.object({
    amount: z.number(),
    currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;
