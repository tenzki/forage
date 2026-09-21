#!/bin/zsh

set -euo pipefail
umask 077

readonly script_directory="${0:A:h}"
readonly default_server_root="${script_directory}/../../.."
readonly server_root="${FORAGE_SERVER_ROOT:-${default_server_root:A}}"
readonly environment_file="${FORAGE_SERVER_ENV_FILE:-${HOME}/.config/forage-server/server.env}"

if [[ ! -r "${environment_file}" ]]; then
  print -u2 "Forage server environment file is not readable: ${environment_file}"
  exit 1
fi

set -a
source "${environment_file}"
set +a

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${FORAGE_INSTANCE_ID:?FORAGE_INSTANCE_ID is required}"
: "${FORAGE_ASSET_DIR:?FORAGE_ASSET_DIR is required}"
: "${FORAGE_AGENT_ENCRYPTION_KEY:?FORAGE_AGENT_ENCRYPTION_KEY is required}"

mkdir -p "${FORAGE_ASSET_DIR}"

if ! podman info >/dev/null 2>&1; then
  podman machine start >/dev/null 2>&1 || true
  for attempt in {1..24}; do
    podman info >/dev/null 2>&1 && break
    sleep 5
  done
fi
podman info >/dev/null 2>&1 || {
  print -u2 "The Podman machine did not become ready."
  exit 1
}

podman compose \
  --env-file "${environment_file}" \
  --file "${server_root}/compose.server.yaml" \
  up -d --wait

cd "${server_root}"
pnpm --filter @forage/server db:migrate
exec pnpm --filter @forage/server start
