FROM node:24-alpine AS builder

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY} \
    npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable pnpm \
    && pnpm config set registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json eslint.config.js .prettierrc.json ./
COPY src ./src
COPY --from=contracts integration-contract/openapi.yaml /contracts/integration-contract/openapi.yaml
COPY --from=contracts integration-contract/v6 /contracts/integration-contract/v6
COPY --from=contracts execution-contract /contracts/execution-contract
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
