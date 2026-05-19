import type { Hono, Context, MiddlewareHandler } from "hono";
import type { z, ZodTypeAny } from "zod";
import { zValidator } from "@hono/zod-validator";
import type {
    InternalContract,
    InferParams,
    InferQuery,
    InferRequest,
    InferResponse,
} from "@trader/contracts";

/**
 * Producer-side binding for an InternalContract. Mounts the route at `contract.path`,
 * attaches `zValidator` for params/body when the contract declares them, and types the
 * handler so `params` and `body` are inferred from the contract's schemas — the same
 * inference the consumer-side `createInternalCaller` uses.
 *
 * Middleware (auth gates etc.) pass between contract and handler:
 *
 *   bindContract(app, getCashContract, requireInternal, requireCaller(...getCashContract.callerScope),
 *       async ({ deps }) => ({ free, total }));
 *
 * The handler returns the typed response value; bindContract serialises it with
 * `c.json(...)`. Handlers that need raw Response control can return `c.text(...)` etc.
 * but lose the typed-response check.
 */
export interface BoundContext<C extends InternalContract<ZodTypeAny | undefined, ZodTypeAny | undefined, ZodTypeAny | undefined, ZodTypeAny | undefined>> {
    c: Context;
    params: InferParams<C>;
    query: InferQuery<C>;
    body: InferRequest<C>;
}

export type ContractHandler<C extends InternalContract<ZodTypeAny | undefined, ZodTypeAny | undefined, ZodTypeAny | undefined, ZodTypeAny | undefined>> = (
    ctx: BoundContext<C>,
) => Promise<InferResponse<C>> | InferResponse<C>;

export function bindContract<
    C extends InternalContract<ZodTypeAny | undefined, ZodTypeAny | undefined, ZodTypeAny | undefined, ZodTypeAny | undefined>,
>(
    app: Hono,
    contract: C,
    ...rest: [...middleware: MiddlewareHandler[], handler: ContractHandler<C>]
): void {
    const handler = rest.pop() as ContractHandler<C>;
    const middleware = rest as MiddlewareHandler[];

    const validators: MiddlewareHandler[] = [];
    if (contract.paramsSchema)  validators.push(zValidator("param", contract.paramsSchema as ZodTypeAny));
    if (contract.querySchema)   validators.push(zValidator("query", contract.querySchema  as ZodTypeAny));
    if (contract.requestSchema) validators.push(zValidator("json",  contract.requestSchema as ZodTypeAny));

    const wrapped: MiddlewareHandler = async (c) => {
        const params = (contract.paramsSchema  ? c.req.valid("param" as never) : {}) as InferParams<C>;
        const query  = (contract.querySchema   ? c.req.valid("query" as never) : {}) as InferQuery<C>;
        const body   = (contract.requestSchema ? c.req.valid("json"  as never) : undefined) as InferRequest<C>;
        const result = await handler({ c, params, query, body });
        if (result === undefined) return c.body(null, 200);
        return c.json(result as Record<string, unknown>);
    };

    const allHandlers = [...middleware, ...validators, wrapped];
    const method = contract.method.toLowerCase() as "get" | "post" | "put" | "delete";
    // Hono's typing for variadic middleware + handler is awkward; cast at the boundary.
    const register = (app as unknown as Record<string, (path: string, ...mw: MiddlewareHandler[]) => void>)[method]!;
    register.call(app, contract.path, ...allHandlers);
}

// Re-export z for consumers that only need the type symbol.
export type { z };
