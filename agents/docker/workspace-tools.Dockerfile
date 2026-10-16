FROM mcr.microsoft.com/devcontainers/universal:6-noble

RUN npm install -g \
    @colbymchenry/codegraph \
    @playwright/mcp@0.0.83 \
    playwright@1.64.1 \
    && playwright install --with-deps chromium