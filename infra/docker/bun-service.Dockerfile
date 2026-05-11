FROM oven/bun:1.1 AS base
WORKDIR /app

# Install workspace root dependencies
COPY package.json bun.lockb* ./
COPY packages/ ./packages/

# Install dependencies for the target service
ARG SERVICE
COPY services/${SERVICE}/package.json ./services/${SERVICE}/
RUN bun install --frozen-lockfile

# Copy service source
COPY services/${SERVICE}/src ./services/${SERVICE}/src

WORKDIR /app/services/${SERVICE}
ENV NODE_ENV=production

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
