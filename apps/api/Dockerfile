# API image: a self-contained esbuild bundle on node:22-alpine (no node_modules at runtime).
# Build from the repository root:  docker build -f apps/api/Dockerfile -t feedbacks-api .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@feedbacks/api..." && pnpm --filter @feedbacks/api build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production API_PORT=3000 MIGRATIONS_DIR=/app/dist/migrations
COPY --from=build /repo/apps/api/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
# Apply pending migrations, then serve
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/index.js"]
