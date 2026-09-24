# Web image: static SPA served by nginx, which is also the single entry point:
#   /       → the app        /api/* → API        /sync/* → zero-cache (WebSocket)
# Build from the repository root:  docker build -f apps/web/Dockerfile -t feedbacks-web .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@feedbacks/web..." && pnpm --filter @feedbacks/web build

FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
ENV API_UPSTREAM=api:3000 ZERO_UPSTREAM=zero-cache:4848
EXPOSE 80
