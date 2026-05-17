import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
    "packages/*",
    "services/api-gateway",
    "services/auth-service",
    "services/market-data-service",
    "services/notification-service",
    "services/portfolio-service",
    "services/signal-service",
    "services/trading-service",
]);
