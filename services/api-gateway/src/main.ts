// Phase 3 partial: env.ts fail-fast at boot; bulk wiring stays in index.ts (tracked in PROGRESS.md).
import { createLogger } from "@trader/core";
import { loadGatewayEnv } from "./env.ts";

const env = loadGatewayEnv();
const _logger = createLogger({ service: "api-gateway", level: env.LOG_LEVEL });

await import("./index.ts");
