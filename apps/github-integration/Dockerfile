FROM node:24-bookworm-slim AS builder

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
    && pnpm install --frozen-lockfile

COPY . ./
RUN pnpm run build

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

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable pnpm \
    && pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist
RUN rm -rf dist/test

CMD ["node", "dist/app.js"]
