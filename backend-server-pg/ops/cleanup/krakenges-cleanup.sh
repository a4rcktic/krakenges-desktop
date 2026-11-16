#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Kraken Ges — ejecuta la limpieza de datos caducados.
#
# Uso manual:
#   sudo -u krakenges /opt/krakenges/backend/ops/cleanup/krakenges-cleanup.sh
#
# Lo normal es que lo lance krakenges-cleanup.timer una vez al día.
# ---------------------------------------------------------------------------
set -euo pipefail
umask 077

ENV_FILE="${KRAKENGES_ENV_FILE:-/etc/krakenges/backend.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/cleanup.sql"

log() {
  printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

read_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -v key="$key" '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      if (index(line, key "=") == 1) {
        value = substr(line, length(key) + 2)
        sub(/^[[:space:]]*/, "", value)
        sub(/[[:space:]]*$/, "", value)
        if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) {
          value = substr(value, 2, length(value) - 2)
        }
        print value
        exit
      }
    }
  ' "$ENV_FILE"
}

[[ -f "$SQL_FILE" ]] || die "no existe $SQL_FILE"
command -v psql >/dev/null 2>&1 || die "psql no está instalado"

if [[ -z "${DATABASE_URL:-}" ]]; then
  DATABASE_URL="$(read_env_value DATABASE_URL)"
fi

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL no está definida"

log "Iniciando limpieza"
PGOPTIONS='-c statement_timeout=120000' \
  psql \
    --no-psqlrc \
    --dbname="$DATABASE_URL" \
    --set=ON_ERROR_STOP=1 \
    --file="$SQL_FILE"
log "Limpieza completada"
