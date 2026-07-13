# syntax=docker/dockerfile:1
FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY drizzle ./drizzle
COPY assets ./assets
COPY src ./src
# Migrations run on startup inside src/index.ts before the gateway connects.
CMD ["bun", "run", "src/index.ts"]
