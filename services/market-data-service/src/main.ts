// Entry point for market-data-service.
//
// Boots in this order:
//   1. Parse env (zod fail-fast).
//   2. Stash the parsed env on the runtime-env shim so index.ts (and any other module
//      under src/) reads validated values instead of process.env.
//   3. Construct logger; bind to the module-local `log` shim so legacy module-scope
//      code in index.ts emits structured Pino logs.
//   4. Configure the t212-client and live-config modules with env-derived options so
//      they don't reach into process.env.
//   5. Import index.ts — which executes its module-scope wiring under the now-configured
//      logger + clients + runtime env.
//
// The bulk of the service still wires at module scope inside index.ts; reshaping into a
// proper wiring.ts is tracked in PROGRESS.md as a follow-up. Until then, main.ts is the
// one place that knows how to map env → module-state.

import { createLogger } from "@trader/core";
import { loadMarketDataEnv } from "./env.ts";
import { setRuntimeEnv } from "./runtime-env.ts";
import { setLogger } from "./logger.ts";
import { configureT212Client } from "./t212-client.ts";
import { configureLiveConfig } from "./live-config.ts";

const env = loadMarketDataEnv();
setRuntimeEnv(env);

const logger = createLogger({ service: "market-data-service", level: env.LOG_LEVEL });
setLogger(logger);

const live = env.TRADING_MODE === "Live";
configureT212Client({
    apiKey:   live ? env.T212_API_KEY    ?? "" : env.T212_API_KEY_DEMO    ?? "",
    apiKeyId: live ? env.T212_API_KEY_ID ?? "" : env.T212_API_KEY_ID_DEMO ?? "",
    live,
});

configureLiveConfig({
    barFrequency:   env.BAR_FREQUENCY,
    // POLL_INTERVAL_MS is optional in the schema; fall back to the bar-frequency-dependent
    // default that matches the legacy live-config behaviour (24h for daily, 15m for intraday).
    pollIntervalMs: env.POLL_INTERVAL_MS ?? (env.BAR_FREQUENCY === "daily" ? 24 * 60 * 60_000 : 15 * 60_000),
});

await import("./index.ts");
