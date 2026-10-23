# syntax=docker/dockerfile:1
# Bun 1.4 é o runtime do repo: o `bun.lock` (lockfileVersion 2) não é lido por 1.1.x.
FROM oven/bun:1.4.3-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# `--packages=external`: Bun 1.4 falha o bundle em `require()` condicional de
# dependências opcionais (dialects do knex, @nestjs/microservices, …). O runtime
# já recebe `node_modules`, então só as fontes do projeto são bundladas.
RUN bun build src/main.ts --target=bun --outfile=dist/main.js --packages=external

FROM oven/bun:1.4.3-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# `src` é necessário para os CLIs (migrate/seed) executados como script Bun.
COPY src ./src
COPY tsconfig.json package.json ./
USER bun
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health/live" || exit 1
CMD ["bun", "run", "dist/main.js"]
