FROM oven/bun:1.2 AS deps
WORKDIR /app
COPY services/frontend-web/portal/package.json ./
COPY services/frontend-web/portal/bun.lock* ./
# Install without --frozen-lockfile so adding recharts (or other deps) after
# bootstrap doesn't require a separate lockfile commit.
RUN bun install

FROM oven/bun:1.2 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY services/frontend-web/portal/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

FROM oven/bun:1.2 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app ./
EXPOSE 3000
CMD ["bun", "run", "start"]
