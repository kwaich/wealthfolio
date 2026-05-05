#!/bin/sh
set -e

if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  # Restore DB from replica on cold start if it doesn't exist yet
  if [ ! -f "${WF_DB_PATH:-/data/wealthfolio.db}" ]; then
    litestream restore \
      -if-replica-exists \
      -o "${WF_DB_PATH:-/data/wealthfolio.db}" \
      "$LITESTREAM_REPLICA_URL"
  fi

  exec litestream replicate \
    -exec "/usr/local/bin/wealthfolio-server" \
    "${WF_DB_PATH:-/data/wealthfolio.db}" "$LITESTREAM_REPLICA_URL"
else
  exec /usr/local/bin/wealthfolio-server
fi
