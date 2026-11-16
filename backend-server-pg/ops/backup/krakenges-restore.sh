#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Kraken Ges — restauración de una copia lógica de PostgreSQL.
#
# Uso:
#   sudo -u krakenges /opt/krakenges/backend/ops/backup/krakenges-restore.sh \
#     /var/backups/krakenges/krakenges-20261104T041500Z.dump --yes
#
# ¡DESTRUCTIVO! pg_restore --clean borra los objetos existentes del esquema
# antes de recrearlos. Úsalo sobre una base de datos vacía o de pruebas, o
# durante una recuperación real con el backend parado.
#
# Variables:
#   KRAKENGES_ENV_FILE   (default /etc/krakenges/backend.env)
#   TARGET_DATABASE_URL  (si falta, se usa DATABASE_URL)
#   RESTORE_ROLE         (opcional, se pasa a pg_restore --role)
# ---------------------------------------------------------------------------
set -euo pipefail
umask 077

ENV_FILE="${KRAKENGES_ENV_FILE:-/etc/krakenges/backend.env}"

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

DUMP="${1:-}"
CONFIRM="${2:-}"

[[ -n "$DUMP" ]] || die "uso: $0 <fichero.dump> [--yes]"
[[ -f "$DUMP" ]] || die "no existe el fichero: $DUMP"
command -v pg_restore >/dev/null 2>&1 || die "pg_restore no está instalado"

if [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
  TARGET_DATABASE_URL="$(read_env_value TARGET_DATABASE_URL)"
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  DATABASE_URL="$(read_env_value DATABASE_URL)"
fi

TARGET="${TARGET_DATABASE_URL:-${DATABASE_URL:-}}"
[[ -n "$TARGET" ]] || die "TARGET_DATABASE_URL o DATABASE_URL deben estar definidas"

# Comprueba que el fichero es un volcado válido antes de tocar la base.
pg_restore --list "$DUMP" >/dev/null || die "el fichero no es un volcado válido de pg_dump"

if [[ "$CONFIRM" != "--yes" ]]; then
  cat <<EOF
Vas a restaurar:
  $DUMP

Sobre:
  ${TARGET%%\?*}

Esto BORRA los objetos actuales del esquema (--clean --if-exists).
Escribe exactamente 'RESTAURAR' para continuar:
EOF
  read -r answer
  [[ "$answer" == "RESTAURAR" ]] || die "cancelado"
fi

log "Iniciando restauración"
ARGS=(
  --dbname="$TARGET"
  --clean
  --if-exists
  --no-owner
  --no-privileges
  --single-transaction
  --exit-on-error
  --verbose
)
if [[ -n "${RESTORE_ROLE:-}" ]]; then
  ARGS+=(--role="$RESTORE_ROLE")
fi

pg_restore "${ARGS[@]}" "$DUMP"
log "Restauración completada. Ejecuta las migraciones pendientes y revisa /health."
