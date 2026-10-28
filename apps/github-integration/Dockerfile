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

# The GitHub integration service materializes review refs over HTTPS and creates
# deterministic input bundles with GNU tar options unsupported by BusyBox tar.
RUN apk add --no-cache ca-certificates git tar

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /prod ./
# The service validates execution results against the canonical contract schemas, which it
# must carry itself (compose supplies `contracts/` only as a build context, not a runtime
# mount). Copy the execution-api family and let the runtime use `EXECUTION_API_VERSION` from
# `src/execution/execution-api-version.ts`. Naming the version here instead can
# leave the image pointing at stale schemas; the image
# now carries no version literal to fall out of sync. The path lands on the resolver's primary
# candidate (`<cwd>/contracts/execution-api/<version>/schemas`, with cwd `/app`) rather
# than its `../../` fallback, and startup verifies the schemas load. The build-only `tools/`
# working tree never reaches this COPY because `contracts/.dockerignore` keeps it out of the
# build context.
COPY --from=contracts execution-api /app/contracts/execution-api
RUN rm -rf dist/test

CMD ["node", "dist/app.js"]
