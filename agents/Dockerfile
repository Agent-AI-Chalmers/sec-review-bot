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
# Copy the whole integration-contract family minus `tools/` (a large build-only working tree)
# and let the resolver pick the version directory itself, via CONTRACT_VERSION_DIR in
# `sec_review_agents/contract_version.py`. Naming the version here instead is what let a v5 ->
# v6 bump leave the image pointing at stale schemas. Compose supplies `contracts/` as a separate
# named context; this lands under `/contracts/integration-contract/`, and
# `SEC_REVIEW_CONTRACTS_ROOT=/contracts` above names the root explicitly — the resolver reads
# that variable rather than searching the filesystem for a directory that happens to match.
COPY --exclude=**/tools --from=contracts integration-contract /contracts/integration-contract
RUN uv sync --frozen --no-dev

CMD ["sec-review-agents-service"]
