// Phase 3 partial: env.ts fail-fast at boot; bulk wiring stays in index.ts (tracked in PROGRESS.md).
import { createLogger } from "@trader/core";
import { loadAuthEnv } from "./env.ts";

const env = loadAuthEnv();
const _logger = createLogger({ service: "auth-service", level: env.LOG_LEVEL });

await import("./index.ts");
