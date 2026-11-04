FROM ghcr.io/pnpm/pnpm:12-alpine AS pnpm

FROM node:26-alpine AS builder

COPY --from=pnpm /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /repo
COPY --from=workspace package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json apps/control-plane-ui/package.json
RUN pnpm config set registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm --filter ./apps/control-plane-ui... install --frozen-lockfile

WORKDIR /repo/apps/control-plane-ui
COPY . ./
RUN pnpm run build
RUN pnpm --filter @sec-review-bot/control-plane-ui deploy --prod /prod

FROM node:26-alpine
WORKDIR /app
COPY --from=builder /repo/apps/control-plane-ui/dist ./dist
COPY --from=builder /repo/apps/control-plane-ui/dist-server ./dist-server
COPY --from=builder /prod/node_modules ./node_modules
COPY --from=builder /prod/package.json ./package.json
USER node
CMD ["node", "dist-server/server/main.js"]
