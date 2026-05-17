// Phase 3 partial: env.ts fail-fast at boot; bulk wiring stays in index.ts (tracked in PROGRESS.md).
import { createLogger } from "@trader/core";
import { loadPortfolioEnv } from "./env.ts";

const env = loadPortfolioEnv();
const _logger = createLogger({ service: "portfolio-service", level: env.LOG_LEVEL });

await import("./index.ts");
