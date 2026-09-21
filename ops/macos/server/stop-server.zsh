#!/bin/zsh

set -euo pipefail

readonly script_directory="${0:A:h}"
server_root="${script_directory}/../../.."
server_root="${server_root:A}"
readonly server_root
readonly environment_file="${FORAGE_SERVER_ENV_FILE:-${HOME}/.config/forage-server/server.env}"
readonly service_target="gui/$(id -u)/com.forage.server"

log() {
  print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

fail() {
  print -u2 -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*"
  exit 1
}

if launchctl print "${service_target}" >/dev/null 2>&1; then
  log "Stopping and unloading the Forage API service."
  launchctl bootout "${service_target}"
else
  log "The Forage API service is not loaded."
fi

if ! command -v podman >/dev/null 2>&1; then
  fail "Podman is unavailable, so the PostgreSQL container could not be stopped."
fi

if ! podman info >/dev/null 2>&1; then
  log "Podman is not running; the PostgreSQL container is already inactive."
  log "Forage server stopped."
  exit 0
fi

[[ -r "${environment_file}" ]] \
  || fail "Server environment file is not readable: ${environment_file}"
[[ -f "${server_root}/compose.server.yaml" ]] \
  || fail "Could not find compose.server.yaml under ${server_root}."

log "Stopping the isolated PostgreSQL service."
podman compose \
  --env-file "${environment_file}" \
  --file "${server_root}/compose.server.yaml" \
  stop

log "Forage server stopped. The Podman machine and database volume remain available."
