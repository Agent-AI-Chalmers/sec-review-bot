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
RUN pnpm run build
RUN pnpm deploy --filter . --prod /app/prod

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/prod/node_modules ./node_modules
COPY --from=builder /app/prod/package.json ./package.json
USER node
CMD ["node", "dist-server/server/index.js"]
