#!/usr/bin/env bash
# Run the Moosic web server. Loads .env if present.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

exec .venv/bin/uvicorn app:asgi_app \
  --host "${MOOSIC_HOST:-127.0.0.1}" \
  --port "${MOOSIC_PORT:-8740}" \
  "$@"
