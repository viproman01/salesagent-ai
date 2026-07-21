#!/bin/sh
set -eu

# Docker Compose provides PostgreSQL fields separately. WHATWG URL
# serialization percent-encodes credentials and database names, without
# placing a raw password in docker-compose.yml or the container command.
if [ -n "${PGHOST:-}" ] || [ -n "${PGUSER:-}" ] || [ -n "${PGDATABASE:-}" ]; then
  : "${PGHOST:?PGHOST is required when using structured PostgreSQL settings}"
  : "${PGPORT:?PGPORT is required when using structured PostgreSQL settings}"
  : "${PGUSER:?PGUSER is required when using structured PostgreSQL settings}"
  : "${PGPASSWORD:?PGPASSWORD is required when using structured PostgreSQL settings}"
  : "${PGDATABASE:?PGDATABASE is required when using structured PostgreSQL settings}"

  DATABASE_URL="$(node <<'NODE'
const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
const port = Number(PGPORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PGPORT must be an integer between 1 and 65535');
}

let host;
if (/^[A-Za-z0-9._-]+$/.test(PGHOST)) {
  host = PGHOST;
} else if (PGHOST.includes(':') && /^[0-9A-Fa-f:]+$/.test(PGHOST)) {
  host = `[${PGHOST}]`;
} else {
  throw new Error('PGHOST must be a hostname, IPv4 address, or IPv6 address');
}

const encode = encodeURIComponent;
process.stdout.write(
  `postgresql://${encode(PGUSER)}:${encode(PGPASSWORD)}@${host}:${port}/${encode(PGDATABASE)}`
);
NODE
)"
  export DATABASE_URL
fi

exec "$@"
