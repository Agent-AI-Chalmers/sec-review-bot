FROM node:24-bookworm-slim AS builder

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY} \
    npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable pnpm \
    && pnpm config set registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm install --frozen-lockfile

COPY . ./
# `copy:spec` reads the hand-written contract to place it (with its digest) beside the
# compiled server, so the builder needs it too. The build resolves the spec at
# `<control-plane root>/../contracts`, and the build context is now this directory alone, so
# compose supplies the contract as a separate `contracts` context. The running image does not
# need the tree: the contract already travels in `dist/openapi.yaml` with its digest.
COPY --from=contracts . /contracts
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
