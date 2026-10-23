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
# Deploy a self-contained production tree: this package is its own workspace
# root, so the default implementation needs no injected workspace packages.
RUN pnpm deploy --filter . --prod /prod

FROM node:24-alpine

# The GitHub integration service needs git and system CA certificates to materialize review
# refs over HTTPS. Alpine's BusyBox already provides the tar used for workspace snapshots.
RUN apk add --no-cache ca-certificates git

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /prod ./
# The service validates execution results against the canonical contract schemas, which it
# must carry itself (compose supplies `contracts/` only as a build context, not a runtime
# mount). Copy the integration-contract family and let the runtime use `CONTRACT_VERSION` from
# `src/execution/contract-version.ts`. Naming the version here instead is what let a v5 -> v6 bump
# leave the image pointing at stale schemas; the image
# now carries no version literal to fall out of sync. The path lands on the resolver's primary
# candidate (`<cwd>/contracts/integration-contract/<version>/schemas`, with cwd `/app`) rather
# than its `../../` fallback, and startup verifies the schemas load. The build-only `tools/`
# working tree never reaches this COPY because `contracts/.dockerignore` keeps it out of the
# build context.
COPY --from=contracts integration-contract /app/contracts/integration-contract
RUN rm -rf dist/test

CMD ["node", "dist/app.js"]
