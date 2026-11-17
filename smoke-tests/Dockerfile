FROM ghcr.io/pnpm/pnpm:12-alpine AS pnpm

FROM node:26-alpine AS probe

COPY --from=pnpm /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"

WORKDIR /repo

# Cache dependency installation independently of probe source changes.
COPY --from=workspace package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json smoke-tests/package.json
RUN pnpm --filter @sec-review-bot/smoke-tests... install --frozen-lockfile --ignore-scripts

WORKDIR /repo/smoke-tests

COPY tsconfig.json *.ts ./
RUN pnpm run build

ENTRYPOINT ["node"]
