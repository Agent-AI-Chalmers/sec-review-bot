FROM ghcr.io/pnpm/pnpm:12-alpine AS pnpm

FROM node:26-alpine AS builder

COPY --from=pnpm /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /repo

COPY --from=workspace package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json services/review-runs/package.json
RUN pnpm config set registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm --filter ./services/review-runs... install --frozen-lockfile

WORKDIR /repo/services/review-runs

COPY . ./
# `copy:spec` reads the hand-written contract to place it (with its digest) beside the
# compiled server, so the builder needs it too. The build resolves the spec at
# `<review-runs root>/../../contracts/review-runs-api/v1/openapi.yaml`, so compose supplies the
# contract as a separate named context and this copies only that one file — not the whole
# tree. The running image does not need it at all: the contract already travels in
# `dist/openapi.yaml` with its digest.
COPY --from=contracts review-runs-api/v1/openapi.yaml /repo/contracts/review-runs-api/v1/openapi.yaml
RUN pnpm run build
# Deploy only this service and its production dependencies.
RUN pnpm --filter @sec-review-bot/review-runs deploy --prod /prod

FROM node:26-alpine

WORKDIR /app

COPY --from=builder /repo/services/review-runs/dist ./dist
COPY --from=builder /prod ./

USER node

CMD ["node", "dist/server.js"]
