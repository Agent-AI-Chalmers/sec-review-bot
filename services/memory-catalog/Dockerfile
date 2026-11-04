FROM ghcr.io/pnpm/pnpm:12-alpine AS pnpm

FROM node:24-alpine AS builder

COPY --from=pnpm /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /repo

COPY --from=workspace package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json services/memory-catalog/package.json
RUN pnpm config set registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm --filter ./services/memory-catalog... install --frozen-lockfile

WORKDIR /repo/services/memory-catalog

COPY tsconfig.json tsconfig.build.json eslint.config.js .prettierrc.json ./
COPY src ./src
COPY --from=contracts memory-catalog-api/v1/openapi.yaml /repo/contracts/memory-catalog-api/v1/openapi.yaml
RUN pnpm run build \
    && pnpm --filter @sec-review-bot/memory-catalog deploy --prod /prod

FROM node:24-alpine

WORKDIR /app

COPY --from=builder /repo/services/memory-catalog/dist ./dist
COPY --from=builder /prod ./

USER node

CMD ["node", "dist/server.js"]
