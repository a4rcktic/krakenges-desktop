#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Kraken Ges — copia de seguridad lógica de PostgreSQL.
#
# Uso:
#   sudo -u krakenges /opt/krakenges/backend/ops/backup/krakenges-backup.sh
#
# Variables:
#   KRAKENGES_ENV_FILE              (default /etc/krakenges/backend.env)
#   KRAKENGES_BACKUP_DIR            (default /var/backups/krakenges)
#   KRAKENGES_BACKUP_RETENTION_DAYS (default 14)
#
# El volcado usa formato custom de pg_dump (comprimido, restaurable con
# pg_restore). Los roles NO se incluyen: viven en ops/postgres/roles.sql.
# ---------------------------------------------------------------------------
set -euo pipefail
umask 077

ENV_FILE="${KRAKENGES_ENV_FILE:-/etc/krakenges/backend.env}"
BACKUP_DIR="${KRAKENGES_BACKUP_DIR:-/var/backups/krakenges}"
RETENTION_DAYS="${KRAKENGES_BACKUP_RETENTION_DAYS:-14}"

log() {
  printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

# Lee una clave del fichero de entorno sin ejecutarlo como shell. Así un
# MAIL_FROM con espacios o un valor con `$` no rompe el script.
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

command -v pg_dump >/dev/null 2>&1 || die "pg_dump no está instalado"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum no está instalado"

if [[ -z "${DATABASE_URL:-}" ]]; then
  DATABASE_URL="$(read_env_value DATABASE_URL)"
fi

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL no está definida"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Evita dos copias simultáneas.
exec 9>"$BACKUP_DIR/.backup.lock"
if ! flock -n 9; then
  die "ya hay una copia de seguridad en curso"
fi

STAMP="$(date -u +'%Y%m%dT%H%M%SZ')"
DUMP="$BACKUP_DIR/krakenges-$STAMP.dump"
CHECKSUM="$DUMP.sha256"
TMP="$DUMP.tmp"

cleanup_tmp() {
  rm -f "$TMP" "$TMP.sha256"
}
trap cleanup_tmp EXIT

log "Volcando base de datos en $DUMP"
pg_dump \
  --dbname="$DATABASE_URL" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="$TMP"

mv "$TMP" "$DUMP"
sha256sum "$DUMP" > "$TMP.sha256"
mv "$TMP.sha256" "$CHECKSUM"
chmod 600 "$DUMP" "$CHECKSUM"

log "Copia completada: $(du -h "$DUMP" | cut -f1)"
log "SHA-256: $(cut -d' ' -f1 "$CHECKSUM")"

# Retención. Solo borra ficheros con el patrón exacto de este script.
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'krakenges-*.dump' -o -name 'krakenges-*.dump.sha256' \) \
  -mtime +"$RETENTION_DAYS" -print -delete |
  while read -r old; do log "Eliminado por retención: $old"; done

log "Retención aplicada: $RETENTION_DAYS días"
