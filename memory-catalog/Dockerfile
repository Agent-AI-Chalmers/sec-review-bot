FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable pnpm \
    && pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json eslint.config.js .prettierrc.json ./
COPY src ./src
COPY --from=contracts memory-catalog-api/openapi.yaml /contracts/memory-catalog-api/openapi.yaml
RUN pnpm run build \
    && pnpm deploy --filter . --prod /prod

FROM node:24-alpine

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /prod ./

USER node

CMD ["node", "dist/server.js"]
