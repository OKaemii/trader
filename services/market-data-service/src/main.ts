// Entry point for the market-data-service.
//
// Phase 3 partial: env.ts is wired here for fail-fast validation at boot; the bulk of
// module-scope wiring (validator, gapDetector, universeManager, bootstrap) still lives
// in index.ts and reads process.env directly. Threading env down through every helper
// is a follow-up (tracked in PROGRESS.md). Until then this file ensures the env schema
// is checked before any downstream code runs.

import { createLogger } from "@trader/core";
import { loadMarketDataEnv } from "./env.ts";

const env = loadMarketDataEnv();
// Logger is constructed so subsequent imports can surface it via a getter if needed.
// Not yet plumbed through — downstream still uses console.* until the per-site migration.
const _logger = createLogger({ service: "market-data-service", level: env.LOG_LEVEL });

// Triggering the existing bootstrap. index.ts owns the validator / gapDetector / universeManager
// module-scope wiring and the serve() call. Importing it executes that wiring under the
// already-validated env.
await import("./index.ts");
