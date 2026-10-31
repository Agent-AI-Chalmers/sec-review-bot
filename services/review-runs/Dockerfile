FROM ghcr.io/pnpm/pnpm:12-alpine AS pnpm

FROM node:24-alpine AS builder

COPY --from=pnpm /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm config set registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm install --frozen-lockfile

COPY . ./
# `copy:spec` reads the hand-written contract to place it (with its digest) beside the
# compiled server, so the builder needs it too. The build resolves the spec at
# `<review-runs root>/../../contracts/review-runs-api/v1/openapi.yaml`, so compose supplies the
# contract as a separate named context and this copies only that one file — not the whole
# tree. The running image does not need it at all: the contract already travels in
# `dist/openapi.yaml` with its digest.
COPY --from=contracts review-runs-api/v1/openapi.yaml /contracts/review-runs-api/v1/openapi.yaml
RUN pnpm run build
# Deploy a self-contained production tree: this package is its own workspace
# root, so the default implementation needs no injected workspace packages.
RUN pnpm deploy --filter . --prod /prod

FROM node:24-alpine

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /prod ./

USER node

CMD ["node", "dist/server.js"]
