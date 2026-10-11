FROM node:24-bookworm-slim AS builder

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY} \
    npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /app

COPY control-plane/package.json control-plane/pnpm-lock.yaml control-plane/pnpm-workspace.yaml ./
RUN corepack enable pnpm \
    && pnpm config set registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm install --frozen-lockfile

COPY control-plane/ ./
RUN pnpm run build
# Deploy a self-contained production tree: this package is its own workspace
# root, so the default implementation needs no injected workspace packages.
RUN pnpm deploy --filter . --prod /prod

FROM node:24-bookworm-slim

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /prod ./

USER node

CMD ["node", "dist/server.js"]
