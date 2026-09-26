ARG DOCKER_CLI_IMAGE=docker:27.5.1-cli
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.10.9

FROM ${DOCKER_CLI_IMAGE} AS docker-cli
FROM ${UV_IMAGE} AS uv

FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

# The worker uses the host Docker daemon through /var/run/docker.sock.  It
# therefore needs the Docker client, but must not start a second daemon.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

# Keep the uv tool version explicit: it is a build tool, not an application
# dependency.  Updating it should be a deliberate image-toolchain change.
COPY --from=uv /uv /uvx /bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . ./
RUN uv sync --frozen --no-dev

CMD ["sec-review-agents-service"]
