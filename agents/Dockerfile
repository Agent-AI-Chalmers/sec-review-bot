ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13

FROM ${UV_IMAGE} AS uv

FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH" \
    SEC_REVIEW_CONTRACTS_ROOT=/contracts

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
# The Runner reads only the canonical v5 schemas, so copy just those (not the whole tree, whose
# per-family `tools/` and `pnpm-lock.yaml` it never reads). Compose supplies `contracts/` as a
# separate named context; this lands at `/contracts/integration-contract/v5/schemas`, and
# `SEC_REVIEW_CONTRACTS_ROOT=/contracts` above names it explicitly — the resolver reads that
# variable rather than searching the filesystem for a directory that happens to match.
COPY --from=contracts integration-contract/v5/schemas /contracts/integration-contract/v5/schemas
RUN uv sync --frozen --no-dev

CMD ["sec-review-agents-service"]
