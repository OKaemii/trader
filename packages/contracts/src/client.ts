import type { ZodTypeAny } from "zod";
import type { InternalContract, InferParams, InferQuery, InferRequest, InferResponse } from "./contract.ts";

/**
 * Mints a bearer token for a peer-to-peer call. Caller supplies its own service name
 * (the `sub` claim) — the producer's `requireCaller` middleware checks it against the
 * contract's `callerScope`.
 */
export interface InternalTokenMinter {
    (callerService: string): Promise<string>;
}

/**
 * Per-caller-service preset. Captures the consumer's service name once so individual
 * `call(contract, args)` invocations stay terse.
 */
export interface InternalCallerOptions {
    baseUrl: string;
    callerService: string;
    mintToken: InternalTokenMinter;
    /** Override fetch (testing). Defaults to the global. */
    fetcher?: typeof fetch;
}

/**
 * Builds the typed peer-call function for a service. Returns `call(contract, args?)`
 * with full type inference: the response type comes from `contract.responseSchema`,
 * the request body from `contract.requestSchema`, path params from `contract.paramsSchema`.
 *
 * Usage:
 *
 *   const trading = createInternalCaller({
 *       baseUrl: env.TRADING_SERVICE_URL,
 *       callerService: "signal-service",
 *       mintToken: mintInternalJwt,
 *   });
 *   const cash = await trading(getCashContract);
 *   // cash is typed CashResponse — zod-parsed from the wire.
 */
export function createInternalCaller(opts: InternalCallerOptions) {
    const fetcher = opts.fetcher ?? fetch;
    return async function call<
        C extends InternalContract<ZodTypeAny | undefined, ZodTypeAny | undefined, ZodTypeAny | undefined, ZodTypeAny | undefined>,
    >(
        contract: C,
        args?: { params?: InferParams<C>; query?: InferQuery<C>; body?: InferRequest<C> },
    ): Promise<InferResponse<C>> {
        const token = await opts.mintToken(opts.callerService);
        const path = interpolatePath(contract.path, args?.params as Record<string, unknown> | undefined);
        const qs = args?.query ? buildQueryString(args.query as Record<string, unknown>) : "";
        const url = `${opts.baseUrl}${path}${qs}`;
        const init: RequestInit = {
            method: contract.method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(args?.body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            ...(args?.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
        };
        const res = await fetcher(url, init);
        if (!res.ok) {
            throw new InternalCallError(contract.method, contract.path, res.status, await res.text().catch(() => ""));
        }
        const schema = contract.responseSchema;
        if (!schema) return undefined as InferResponse<C>;
        const json: unknown = await res.json();
        return schema.parse(json) as InferResponse<C>;
    };
}

export class InternalCallError extends Error {
    constructor(
        readonly method: string,
        readonly path: string,
        readonly status: number,
        readonly body: string,
    ) {
        super(`internal ${method} ${path} → ${status}: ${body.slice(0, 200)}`);
    }
}

function interpolatePath(path: string, params: Record<string, unknown> | undefined): string {
    if (!params) return path;
    return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name) => {
        const value = params[name];
        if (value === undefined || value === null) {
            throw new Error(`missing path param '${name}' for '${path}'`);
        }
        return encodeURIComponent(String(value));
    });
}

function buildQueryString(query: Record<string, unknown>): string {
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return pairs.length ? `?${pairs.join("&")}` : "";
}
