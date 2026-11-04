FROM ghcr.io/pnpm/pnpm:12-alpine AS pnpm

FROM node:26-alpine AS builder

COPY --from=pnpm /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /repo

COPY --from=workspace package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json services/execution-gateway/package.json
RUN pnpm config set registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm --filter ./services/execution-gateway... install --frozen-lockfile

WORKDIR /repo/services/execution-gateway

COPY tsconfig.json tsconfig.build.json eslint.config.js .prettierrc.json ./
COPY src ./src
COPY --from=contracts execution-api /repo/contracts/execution-api
COPY --from=contracts execution-workflow /repo/contracts/execution-workflow
RUN pnpm run build \
    && pnpm --filter @sec-review-bot/execution-gateway deploy --prod /prod

FROM node:26-alpine

WORKDIR /app

ENV SEC_REVIEW_CONTRACTS_ROOT=/contracts

COPY --from=builder /repo/services/execution-gateway/dist ./dist
COPY --from=builder /prod ./
COPY --from=builder /repo/contracts /contracts

USER node

CMD ["node", "dist/server.js"]
