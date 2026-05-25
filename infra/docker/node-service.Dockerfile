FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy workspace root manifest + lockfile + workspace declaration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy all package manifests to satisfy --frozen-lockfile workspace validation
COPY packages/contracts/package.json          ./packages/contracts/
COPY packages/core/package.json               ./packages/core/
COPY packages/shared-auth/package.json        ./packages/shared-auth/
COPY packages/shared-bars/package.json        ./packages/shared-bars/
COPY packages/shared-calendar/package.json    ./packages/shared-calendar/
COPY packages/shared-data/package.json        ./packages/shared-data/
COPY packages/shared-fx/package.json          ./packages/shared-fx/
COPY packages/shared-mongo/package.json       ./packages/shared-mongo/
COPY packages/shared-pg/package.json          ./packages/shared-pg/
COPY packages/shared-portfolio/package.json   ./packages/shared-portfolio/
COPY packages/shared-redis/package.json       ./packages/shared-redis/
COPY packages/shared-types/package.json       ./packages/shared-types/
COPY packages/telemetry/package.json          ./packages/telemetry/
COPY services/auth-service/package.json       ./services/auth-service/
COPY services/frontend-web/package.json       ./services/frontend-web/
COPY services/market-data-service/package.json ./services/market-data-service/
COPY services/notification-service/package.json ./services/notification-service/
COPY services/portfolio-service/package.json  ./services/portfolio-service/
COPY services/signal-service/package.json     ./services/signal-service/
COPY services/trading-service/package.json    ./services/trading-service/
COPY infra/scripts/package.json               ./infra/scripts/

RUN pnpm install --frozen-lockfile

# Copy tsconfigs + source for everything (project references span packages).
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/ ./services/

# Build only the target service and its transitive deps via pnpm filter.
ARG SERVICE
RUN pnpm --filter "@trader/${SERVICE}..." build

FROM node:22-alpine AS runner
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY --from=builder /app/node_modules                              ./node_modules
COPY --from=builder /app/package.json                              ./
COPY --from=builder /app/pnpm-lock.yaml                            ./
COPY --from=builder /app/pnpm-workspace.yaml                       ./
COPY --from=builder /app/packages                                  ./packages
COPY --from=builder /app/services                                  ./services

ARG SERVICE
ENV NODE_ENV=production
ENV SERVICE=${SERVICE}
EXPOSE 3000

# Phase 3 entry: every service ships a dist/main.js that loads env (fail-fast) then
# bootstraps. Fall back to dist/index.js if a service hasn't been migrated yet — both
# are equivalent for trading-service (index.ts triggers main.ts).
CMD ["sh", "-c", "[ -f services/${SERVICE}/dist/main.js ] && exec node services/${SERVICE}/dist/main.js || exec node services/${SERVICE}/dist/index.js"]
