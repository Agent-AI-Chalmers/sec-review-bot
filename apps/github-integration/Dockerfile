FROM node:24-bookworm-slim AS builder

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY} \
    npm_config_registry=${NPM_CONFIG_REGISTRY}

# better-sqlite3 may compile native bindings when a prebuild is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        g++ \
        make \
        python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable pnpm \
    && pnpm config set registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm install --frozen-lockfile

COPY . ./
RUN pnpm run build
# This package is the workspace root; legacy deploy keeps pnpm's production
# deployment command usable without injected workspace packages.
RUN pnpm deploy --filter . --prod --legacy /prod

FROM node:24-bookworm-slim

# The GitHub integration service is also the input bundle materializer. It needs git to
# materialize review refs and tar to create / extract workspace snapshots.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /prod ./
RUN rm -rf dist/test

CMD ["node", "dist/app.js"]
