#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

pg_isready --quiet --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"

# A running PostgreSQL image is not enough for this application: fail readiness
# if the selected image does not actually provide the pgvector extension.
vector_available="$(
  psql \
    --no-psqlrc \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --tuples-only \
    --no-align \
    --command="SELECT count(*) FROM pg_available_extensions WHERE name = 'vector'"
)"

[ "$vector_available" = "1" ]
