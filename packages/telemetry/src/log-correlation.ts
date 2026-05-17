import { trace } from "@opentelemetry/api";

/**
 * Pino mixin that surfaces the active OTel span's traceId/spanId on every log line.
 * Pass into `createLogger({ traceMixin })`. Returns an empty object when no span is
 * active, which keeps log shape stable for both traced and untraced paths.
 */
export function traceMixin(): Record<string, string> {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const ctx = span.spanContext();
    return { traceId: ctx.traceId, spanId: ctx.spanId };
}
