FROM mcr.microsoft.com/devcontainers/universal:6-noble

USER root

RUN npm install -g @colbymchenry/codegraph \
    && codegraph --version
