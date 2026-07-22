#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

export PGHOST="${PGHOST:-postgres}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="$POSTGRES_USER"
export PGPASSWORD="$POSTGRES_PASSWORD"
export PGDATABASE="$POSTGRES_DB"

psql_safe() {
  psql --no-psqlrc --set=ON_ERROR_STOP=1 "$@"
}

psql_safe <<'SQL'
CREATE TABLE IF NOT EXISTS public._migrations (
  filename VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SQL

# Validate repository-controlled filenames before generating any SQL from
# them. This keeps the metadata statements below free from SQL metacharacters.
active_migration_found=false
for migration in /migrations/[0-9][0-9][0-9]_*.sql; do
  [ -f "$migration" ] || continue
  active_migration_found=true
  filename="${migration##*/}"
  case "$filename" in
    *[!A-Za-z0-9._-]*)
      echo "Unsafe migration filename: $filename" >&2
      exit 1
      ;;
  esac
done

if [ "$active_migration_found" != "true" ]; then
  echo 'No active migrations matching NNN_*.sql were found.' >&2
  exit 1
fi

migration_count="$(
  psql_safe --tuples-only --no-align \
    --command='SELECT count(*) FROM public._migrations'
)"

# Older versions mounted the complete migrations directory into
# docker-entrypoint-initdb.d and created no migration history. Never infer that
# such a schema is safe to adopt automatically: adoption requires an explicit
# operator opt-in and the complete 001-004 baseline signature below.
if [ "$migration_count" = "0" ]; then
  legacy_complete="$(
    psql_safe --tuples-only --no-align --command="
      SELECT
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
        AND to_regclass('public.organizations') IS NOT NULL
        AND to_regclass('public.users') IS NOT NULL
        AND to_regclass('public.agents') IS NOT NULL
        AND to_regclass('public.leads') IS NOT NULL
        AND to_regclass('public.conversations') IS NOT NULL
        AND to_regclass('public.messages') IS NOT NULL
        AND to_regclass('public.knowledge_chunks') IS NOT NULL
        AND to_regclass('public.call_recordings') IS NOT NULL
        AND to_regclass('public.daily_metrics') IS NOT NULL
        AND to_regclass('public.crm_connections') IS NOT NULL
        AND to_regclass('public.subscriptions') IS NOT NULL
        AND to_regclass('public.usage_events') IS NOT NULL
    "
  )"

  legacy_objects="$(
    psql_safe --tuples-only --no-align --command="
      SELECT count(*)
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relname IN (
          'organizations', 'users', 'agents', 'leads', 'conversations',
          'messages', 'knowledge_chunks', 'call_recordings', 'daily_metrics',
          'crm_connections', 'subscriptions', 'usage_events'
        )
    "
  )"

  if [ "$legacy_objects" != "0" ] \
    && [ "${MIGRATIONS_ADOPT_LEGACY_BASELINE:-false}" != "true" ]; then
    echo 'Legacy schema detected without migration history.' >&2
    echo 'After a backup and manual schema review, explicitly set' >&2
    echo 'MIGRATIONS_ADOPT_LEGACY_BASELINE=true to adopt baseline 001-004.' >&2
    exit 1
  fi

  if [ "$legacy_objects" != "0" ] && [ "$legacy_complete" != "t" ]; then
    echo 'Refusing to adopt a partially initialized legacy schema.' >&2
    echo 'Restore the database or finish the active 001-004 migrations before retrying.' >&2
    exit 1
  fi

  if [ "$legacy_complete" = "t" ]; then
    echo 'Adopting schema created by the legacy PostgreSQL entrypoint.'
    # Register only the four migrations that the legacy entrypoint could have
    # applied. Future migrations must still run after this adoption step.
    # PostgreSQL rolls the metadata transaction back if this process stops.
    for migration in \
      /migrations/001_initial_schema.sql \
      /migrations/002_knowledge_base.sql \
      /migrations/003_analytics.sql \
      /migrations/004_billing.sql; do
      if [ ! -f "$migration" ]; then
        echo "Legacy baseline migration is missing: ${migration##*/}" >&2
        exit 1
      fi
    done

    {
      echo 'BEGIN;'
      for migration in \
        /migrations/001_initial_schema.sql \
        /migrations/002_knowledge_base.sql \
        /migrations/003_analytics.sql \
        /migrations/004_billing.sql; do
        filename="${migration##*/}"
        printf '%s\n' \
          "INSERT INTO public._migrations (filename) VALUES ('$filename') ON CONFLICT (filename) DO NOTHING;"
      done
      echo 'COMMIT;'
    } | psql_safe >/dev/null
  fi
fi

for migration in /migrations/[0-9][0-9][0-9]_*.sql; do
  [ -f "$migration" ] || continue
  filename="${migration##*/}"

  applied="$(
    psql_safe --tuples-only --no-align \
      --command="SELECT count(*) FROM public._migrations WHERE filename = '$filename'"
  )"
  if [ "$applied" = "1" ]; then
    echo "Skipping $filename (already applied)"
    continue
  fi

  echo "Applying $filename"
  psql_safe \
    --single-transaction \
    --file="$migration" \
    --command="INSERT INTO public._migrations (filename) VALUES ('$filename')"
done

vector_version="$(
  psql_safe --tuples-only --no-align \
    --command="SELECT extversion FROM pg_extension WHERE extname = 'vector'"
)"
if [ -z "$vector_version" ]; then
  echo 'pgvector is not installed after migrations.' >&2
  exit 1
fi

echo "Migrations are ready; pgvector $vector_version is installed."
