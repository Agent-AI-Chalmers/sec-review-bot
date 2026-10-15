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
# The service validates runner results against the canonical contract schemas, which it
# must carry itself (compose supplies `contracts/` only as a build context, not a runtime
# mount). Copy the whole integration-contract family minus `tools/` (a 90 MB build-only
# working tree) and let the runtime pick the version directory itself, via
# `CONTRACT_VERSION_DIR` in `src/runner/contract-version.ts`. Naming the version here
# instead is what let a v5 -> v6 bump leave the image pointing at stale schemas; the image
# now carries no version literal to fall out of sync. The path lands on the resolver's
# primary candidate (`<cwd>/contracts/integration-contract/<version>/schemas`, with cwd
# `/app`) rather than its `../../` fallback, and startup verifies the schemas load.
COPY --exclude=**/tools --from=contracts integration-contract /app/contracts/integration-contract
RUN rm -rf dist/test

CMD ["node", "dist/app.js"]
