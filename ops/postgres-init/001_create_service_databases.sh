#!/bin/sh
set -eu

: "${REVIEW_RUNS_POSTGRES_PASSWORD:?REVIEW_RUNS_POSTGRES_PASSWORD is required}"
: "${MEMORY_CATALOG_POSTGRES_PASSWORD:?MEMORY_CATALOG_POSTGRES_PASSWORD is required}"

psql \
  --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set review_runs_password="$REVIEW_RUNS_POSTGRES_PASSWORD" \
  --set memory_catalog_password="$MEMORY_CATALOG_POSTGRES_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE sec_review_review_runs LOGIN PASSWORD %L',
  :'review_runs_password'
) \gexec
SELECT format(
  'CREATE ROLE sec_review_memory_catalog LOGIN PASSWORD %L',
  :'memory_catalog_password'
) \gexec

CREATE DATABASE sec_review_review_runs OWNER sec_review_review_runs;
CREATE DATABASE sec_review_memory_catalog OWNER sec_review_memory_catalog;
SQL
