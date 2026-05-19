import type { z, ZodTypeAny } from "zod";

/**
 * Typed HTTP contract for a single internal endpoint. Both producer and consumer
 * import the same object: the producer binds it to a route handler, the consumer
 * invokes it via `callInternal`. The wire types (params + body + response) are
 * carried by zod schemas — no hand-typed `c.req.json<{...}>()` casts, no manually
 * declared response shapes that drift over time.
 *
 * `callerScope` enumerates the peer services allowed to invoke this endpoint.
 * Producer routes pass `...contract.callerScope` to `requireCaller` and reject
 * other peers; consumer-side it's informational + auditable in one place.
 */
export interface InternalContract<
    Req extends ZodTypeAny | undefined = undefined,
    Res extends ZodTypeAny | undefined = undefined,
    Params extends ZodTypeAny | undefined = undefined,
    Query extends ZodTypeAny | undefined = undefined,
> {
    readonly method: "GET" | "POST" | "PUT" | "DELETE";
    readonly path: string;                          // may contain :param placeholders
    readonly callerScope: readonly string[];         // allowed `sub` claim values
    readonly paramsSchema?: Params;
    readonly querySchema?: Query;
    readonly requestSchema?: Req;
    readonly responseSchema?: Res;
}

export type InferRequest<C> = C extends InternalContract<infer Req, ZodTypeAny | undefined, ZodTypeAny | undefined, ZodTypeAny | undefined>
    ? Req extends ZodTypeAny ? z.infer<Req> : void
    : void;

export type InferResponse<C> = C extends InternalContract<ZodTypeAny | undefined, infer Res, ZodTypeAny | undefined, ZodTypeAny | undefined>
    ? Res extends ZodTypeAny ? z.infer<Res> : void
    : void;

export type InferParams<C> = C extends InternalContract<ZodTypeAny | undefined, ZodTypeAny | undefined, infer P, ZodTypeAny | undefined>
    ? P extends ZodTypeAny ? z.infer<P> : Record<string, never>
    : Record<string, never>;

export type InferQuery<C> = C extends InternalContract<ZodTypeAny | undefined, ZodTypeAny | undefined, ZodTypeAny | undefined, infer Q>
    ? Q extends ZodTypeAny ? z.infer<Q> : Record<string, never>
    : Record<string, never>;

/**
 * Helper that gives the compiler the right contract type. Use this in module exports
 * (e.g. `export const cashContract = defineContract({...});`) so consumers see the
 * narrowed schema types rather than a widened `InternalContract<ZodTypeAny, ZodTypeAny, ZodTypeAny, ZodTypeAny>`.
 */
export const defineContract = <
    Req extends ZodTypeAny | undefined = undefined,
    Res extends ZodTypeAny | undefined = undefined,
    Params extends ZodTypeAny | undefined = undefined,
    Query extends ZodTypeAny | undefined = undefined,
>(c: InternalContract<Req, Res, Params, Query>): InternalContract<Req, Res, Params, Query> => c;
