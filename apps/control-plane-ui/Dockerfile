FROM node:24-bookworm-slim AS builder

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY} \
    npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /app
COPY apps/control-plane-ui/package.json apps/control-plane-ui/pnpm-lock.yaml apps/control-plane-ui/pnpm-workspace.yaml ./
RUN corepack enable pnpm \
    && pnpm config set registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm install --frozen-lockfile
COPY apps/control-plane-ui/ ./
RUN pnpm run build
RUN pnpm deploy --filter . --prod --legacy /app/prod

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/prod/node_modules ./node_modules
COPY --from=builder /app/prod/package.json ./package.json
USER node
CMD ["node", "dist-server/server/index.js"]
