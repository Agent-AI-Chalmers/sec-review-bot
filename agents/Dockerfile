ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.10.9

FROM ${UV_IMAGE} AS uv

FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

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
