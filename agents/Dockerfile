ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13

FROM ${UV_IMAGE} AS uv

FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

# Pin uv to a minor line rather than an exact patch: patch releases add newly
# published Python versions, so following them keeps the image able to install
# the Python this project targets. A major or minor upgrade stays a deliberate
# image-toolchain change.
COPY --from=uv /uv /uvx /bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . ./
# Compose supplies the workspace contracts as a separate build context so the
# Runner image gets canonical schemas without sending the whole repository.
COPY --from=contracts . /contracts
RUN uv sync --frozen --no-dev

CMD ["sec-review-agents-service"]
