FROM oven/bun:1.2 AS base
WORKDIR /app

# Copy workspace root manifest + lockfile
COPY package.json bun.lock* ./

# Copy all package manifests to satisfy --frozen-lockfile workspace validation
COPY packages/ ./packages/
COPY services/api-gateway/package.json        ./services/api-gateway/
COPY services/auth-service/package.json       ./services/auth-service/
COPY services/frontend-web/package.json       ./services/frontend-web/
COPY services/market-data-service/package.json ./services/market-data-service/
COPY services/notification-service/package.json ./services/notification-service/
COPY services/portfolio-service/package.json  ./services/portfolio-service/
COPY services/signal-service/package.json     ./services/signal-service/
COPY services/trading-service/package.json    ./services/trading-service/
COPY infra/scripts/package.json               ./infra/scripts/

RUN bun install --frozen-lockfile

# Copy source for the target service only
ARG SERVICE
COPY services/${SERVICE}/src ./services/${SERVICE}/src

WORKDIR /app/services/${SERVICE}
ENV NODE_ENV=production

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
