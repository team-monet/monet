# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS workspace-manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/mcp-tools/package.json packages/mcp-tools/package.json
COPY packages/types/package.json packages/types/package.json

FROM workspace-manifests AS workspace-deps
RUN pnpm install --frozen-lockfile

FROM workspace-deps AS api-build
COPY . .
RUN pnpm turbo build --filter=@monet/api

FROM workspace-deps AS dashboard-build
COPY . .
RUN pnpm turbo build --filter=@monet/dashboard

FROM workspace-deps AS migrate-build
COPY . .
RUN pnpm turbo build --filter=@monet/db

FROM base AS api-prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/mcp-tools/package.json packages/mcp-tools/package.json
COPY packages/types/package.json packages/types/package.json
RUN pnpm install --frozen-lockfile --prod --filter @monet/api...

FROM base AS migrate-prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json packages/db/package.json
COPY packages/types/package.json packages/types/package.json
RUN pnpm install --frozen-lockfile --prod --filter @monet/db...

FROM node:22-alpine AS api-runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-prod-deps /app/node_modules /app/node_modules
COPY --from=api-prod-deps /app/package.json /app/package.json
COPY --from=api-prod-deps /app/pnpm-lock.yaml /app/pnpm-lock.yaml
COPY --from=api-prod-deps /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --from=api-prod-deps /app/apps/api/package.json /app/apps/api/package.json
COPY --from=api-prod-deps /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=api-prod-deps /app/packages/db/package.json /app/packages/db/package.json
COPY --from=api-prod-deps /app/packages/db/node_modules /app/packages/db/node_modules
COPY --from=api-prod-deps /app/packages/mcp-tools/package.json /app/packages/mcp-tools/package.json
COPY --from=api-prod-deps /app/packages/mcp-tools/node_modules /app/packages/mcp-tools/node_modules
COPY --from=api-prod-deps /app/packages/types/package.json /app/packages/types/package.json
COPY --from=api-prod-deps /app/packages/types/node_modules /app/packages/types/node_modules
COPY --from=api-build /app/apps/api/dist /app/apps/api/dist
COPY --from=api-build /app/packages/db/dist /app/packages/db/dist
COPY --from=api-build /app/packages/mcp-tools/dist /app/packages/mcp-tools/dist
COPY --from=api-build /app/packages/types/dist /app/packages/types/dist
EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]

FROM node:22-alpine AS migrate-runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=migrate-prod-deps /app/node_modules /app/node_modules
COPY --from=migrate-prod-deps /app/package.json /app/package.json
COPY --from=migrate-prod-deps /app/pnpm-lock.yaml /app/pnpm-lock.yaml
COPY --from=migrate-prod-deps /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --from=migrate-prod-deps /app/packages/db/package.json /app/packages/db/package.json
COPY --from=migrate-prod-deps /app/packages/db/node_modules /app/packages/db/node_modules
COPY --from=migrate-prod-deps /app/packages/types/package.json /app/packages/types/package.json
COPY --from=migrate-prod-deps /app/packages/types/node_modules /app/packages/types/node_modules
COPY --from=migrate-build /app/packages/db/dist /app/packages/db/dist
COPY --from=migrate-build /app/packages/db/drizzle /app/packages/db/drizzle
COPY --from=migrate-build /app/packages/types/dist /app/packages/types/dist
CMD ["node", "packages/db/dist/migrate.js"]

FROM node:22-alpine AS dashboard-runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=dashboard-build /app/apps/dashboard/.next/standalone /app
COPY --from=dashboard-build /app/apps/dashboard/.next/static /app/apps/dashboard/.next/static
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
