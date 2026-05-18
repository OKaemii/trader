// Entry point for the market-data-service.
//
// Phase 3 partial: env.ts is wired here for fail-fast validation at boot; the bulk of
// module-scope wiring (validator, gapDetector, universeManager, bootstrap) still lives
// in index.ts. main.ts sets a service-wide Pino logger via setLogger() before importing
// index.ts so the module-scope console.* equivalents route through the structured logger.

import { createLogger } from "@trader/core";
import { loadMarketDataEnv } from "./env.ts";
import { setLogger } from "./logger.ts";

const env = loadMarketDataEnv();
const logger = createLogger({ service: "market-data-service", level: env.LOG_LEVEL });
setLogger(logger);

// Triggering the existing bootstrap. index.ts owns the module-scope wiring and serve()
// call; it consumes `log` from logger.ts which is now backed by the Pino instance above.
await import("./index.ts");
