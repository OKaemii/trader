import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export interface TracerConfig {
    service: string;
    otlpEndpoint?: string | undefined;
}

/**
 * Boots OpenTelemetry tracing. Returns null when `otlpEndpoint` is undefined — services
 * boot fine in dev / when the collector is down; trace fields just don't appear on log
 * lines until the collector is reachable.
 */
export function startTracer(cfg: TracerConfig): NodeSDK | null {
    if (!cfg.otlpEndpoint) return null;
    const sdk = new NodeSDK({
        serviceName: cfg.service,
        traceExporter: new OTLPTraceExporter({ url: cfg.otlpEndpoint }),
        instrumentations: [
            getNodeAutoInstrumentations({
                "@opentelemetry/instrumentation-fs": { enabled: false },
            }),
        ],
    });
    sdk.start();
    return sdk;
}
