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
RUN pnpm run build
# Deploy a self-contained production tree: this package is its own workspace
# root, so the default implementation needs no injected workspace packages.
RUN pnpm deploy --filter . --prod /prod

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
# The runtime reads canonical schemas from `contracts/integration-contract/v5/schemas`
# (found relative to the process working directory, which is /app). Compose supplies the
# `contracts/` tree as a separate named context; copy only the schemas the service reads,
# not the whole tree (each family's `tools/` and its `pnpm-lock.yaml` would otherwise ride
# along into the runtime image). The path lands on the resolver's primary candidate rather
# than its `../../` fallback.
COPY --from=contracts integration-contract/v5/schemas /app/contracts/integration-contract/v5/schemas
RUN rm -rf dist/test

CMD ["node", "dist/app.js"]
