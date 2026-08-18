#!/bin/sh
# Builds DATABASE_URL from the mounted PostgreSQL password secret, then execs
# the requested command. The password never leaves the container environment
# and is never written to the image, compose files, or Git.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  password_file="${POSTGRES_PASSWORD_FILE:-}"
  if [ -n "$password_file" ] && [ -f "$password_file" ]; then
    # NOTE: variable assignments must precede the command name; placing them
    # after `node -e '...'` makes the shell pass them as node arguments.
    DATABASE_URL="$(
      PW_FILE="$password_file" \
        PG_USER="${POSTGRES_USER:-project_operations}" \
        PG_HOST="${POSTGRES_HOST:-postgres}" \
        PG_PORT="${POSTGRES_PORT:-5432}" \
        PG_DB="${POSTGRES_DB:-project_operations}" \
        node -e '
        const fs = require("node:fs");
        const password = fs.readFileSync(process.env.PW_FILE, "utf8").trim();
        const user = process.env.PG_USER;
        const host = process.env.PG_HOST;
        const port = process.env.PG_PORT;
        const db = process.env.PG_DB;
        // Percent-encode the password so reserved characters survive URL parsing.
        const encoded = encodeURIComponent(password);
        process.stdout.write("postgresql://" + user + ":" + encoded + "@" + host + ":" + port + "/" + db);
      '
    )"
    export DATABASE_URL
  else
    echo "DATABASE_URL unset and no readable POSTGRES_PASSWORD_FILE found" >&2
    exit 1
  fi
fi

exec "$@"
