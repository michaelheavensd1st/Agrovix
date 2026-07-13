# syntax=docker/dockerfile:1.6
# =========================================================================
# Agrovix AgOS — Next.js web image (multi-stage)
# =========================================================================
FROM node:20-alpine AS base
RUN corepack enable

# ---- deps ----
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages ./packages
RUN corepack prepare pnpm@9.12.0 --activate && \
    pnpm install --filter @agrovix/web...

# ---- build ----
FROM base AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY . .
RUN corepack prepare pnpm@9.12.0 --activate && \
    pnpm --filter @agrovix/web build

# ---- runner ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /repo/apps/web/.next ./.next
COPY --from=builder /repo/apps/web/package.json ./package.json
COPY --from=builder /repo/apps/web/next.config.js ./next.config.js
COPY --from=builder /repo/apps/web/public ./public
COPY --from=builder /repo/node_modules ./node_modules

EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
