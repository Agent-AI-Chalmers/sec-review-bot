FROM ghcr.io/joernio/joern:master AS joern

FROM mcr.microsoft.com/devcontainers/universal:6-noble

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PATH="/opt/joern:${PATH}"

COPY --from=joern /opt/joern /opt/joern

RUN npm install -g \
    @colbymchenry/codegraph@1.6.2 \
    @playwright/mcp@0.0.83 \
    playwright@1.64.1 \
    && playwright install --with-deps chromium
