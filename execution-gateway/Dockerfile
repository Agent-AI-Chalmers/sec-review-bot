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

COPY tsconfig.json tsconfig.build.json eslint.config.js .prettierrc.json ./
COPY src ./src
COPY --from=contracts execution-api /contracts/execution-api
COPY --from=contracts execution-workflow /contracts/execution-workflow
RUN pnpm run build \
    && pnpm deploy --filter . --prod /prod

FROM node:24-alpine

WORKDIR /app

ENV SEC_REVIEW_CONTRACTS_ROOT=/contracts

COPY --from=builder /app/dist ./dist
COPY --from=builder /prod ./
COPY --from=builder /contracts /contracts

USER node

CMD ["node", "dist/server.js"]
