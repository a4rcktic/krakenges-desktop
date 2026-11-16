#!/usr/bin/env bash
# Backup cifrado de MongoDB para Kraken Ges.
#
# No genera ficheros en claro: exige un destinatario age o GPG. El checksum se
# calcula sobre el fichero cifrado y se guarda junto a él.
#
# Uso:
#   MONGO_URI='mongodb://...' BACKUP_AGE_RECIPIENT='age1...' ./krakenges-backup.sh
#   ./krakenges-backup.sh --dry-run
#   ./krakenges-backup.sh --no-retention
#
# Variables obligatorias:
#   MONGO_URI              URI de MongoDB con permisos de lectura.
#   BACKUP_AGE_RECIPIENT   Clave pública age, o
#   BACKUP_GPG_RECIPIENT   Huella/clave pública GPG. Solo una de las dos.
#
# Variables opcionales:
#   MONGO_DB               Base de datos. Por defecto: krakenges.
#   BACKUP_DIR             Destino. Por defecto: /var/backups/krakenges.
#   BACKUP_KEEP_DAYS       Días de retención. Por defecto: 14.
#   BACKUP_KEEP_MIN        Copias mínimas que nunca se borran. Por defecto: 7.
#
# El fichero de entorno del servicio systemd NO se interpreta con `source`:
# systemd lo lee como KEY=valor. Para ejecutarlo a mano, exporta las variables.

set -Eeuo pipefail
umask 077

usage() {
  cat <<'EOF'
Backup cifrado de MongoDB para Kraken Ges.

Opciones:
  --dry-run        Valida configuración y herramientas, sin tocar MongoDB.
  --no-retention   No borra copias antiguas.
  -h, --help       Muestra esta ayuda.

Variables:
  MONGO_URI, MONGO_DB, BACKUP_DIR, BACKUP_KEEP_DAYS, BACKUP_KEEP_MIN
  BACKUP_AGE_RECIPIENT o BACKUP_GPG_RECIPIENT (obligatoria una)

Ejemplo:
  MONGO_URI='mongodb://usuario:clave@127.0.0.1:27017/krakenges?authSource=admin' \
  BACKUP_AGE_RECIPIENT='age1...' \
  ./krakenges-backup.sh
EOF
}

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

DRY_RUN=0
RETENTION=1
for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --no-retention) RETENTION=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Opción desconocida: $argument. Usa --help." ;;
  esac
done

: "${MONGO_URI:?Define MONGO_URI con la cadena de conexión a MongoDB.}"
MONGO_DB="${MONGO_DB:-krakenges}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/krakenges}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
BACKUP_KEEP_MIN="${BACKUP_KEEP_MIN:-7}"

[[ "$MONGO_DB" =~ ^[A-Za-z0-9_-]+$ ]] || die "MONGO_DB solo admite letras, números, guiones y guiones bajos."
[[ "$BACKUP_KEEP_DAYS" =~ ^[0-9]+$ ]] || die "BACKUP_KEEP_DAYS debe ser un número entero."
[[ "$BACKUP_KEEP_MIN" =~ ^[0-9]+$ ]] || die "BACKUP_KEEP_MIN debe ser un número entero."
(( BACKUP_KEEP_MIN >= 1 )) || die "BACKUP_KEEP_MIN debe ser al menos 1."

if [[ -n "${BACKUP_AGE_RECIPIENT:-}" && -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  die "Define BACKUP_AGE_RECIPIENT o BACKUP_GPG_RECIPIENT, no las dos."
fi
if [[ -z "${BACKUP_AGE_RECIPIENT:-}" && -z "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  die "Falta el destinatario de cifrado. Define BACKUP_AGE_RECIPIENT o BACKUP_GPG_RECIPIENT."
fi

command -v mongodump >/dev/null 2>&1 || die "No está instalado mongodump (paquete mongodb-database-tools)."
command -v sha256sum >/dev/null 2>&1 || die "No está instalado sha256sum."
command -v flock >/dev/null 2>&1 || die "No está instalado flock."
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  command -v age >/dev/null 2>&1 || die "No está instalado age."
  ENCRYPTION="age"
else
  command -v gpg >/dev/null 2>&1 || die "No está instalado gpg."
  ENCRYPTION="gpg"
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || die "Ya hay un backup en curso (lock ocupado)."

if (( DRY_RUN )); then
  log "Dry run OK: mongodump, $ENCRYPTION, flock y $BACKUP_DIR están disponibles."
  log "Se respaldaría la base $MONGO_DB con retención de $BACKUP_KEEP_DAYS días (mínimo $BACKUP_KEEP_MIN copias)."
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
base="krakenges-$timestamp.dump.gz"
temporary="$(mktemp "$BACKUP_DIR/.krakenges-$timestamp.XXXXXX")"
rm -f -- "$temporary"
archive=""
cleanup() {
  rm -f -- "$temporary"
  if [[ -n "$archive" && -f "$archive.partial" ]]; then
    rm -f -- "$archive.partial"
  fi
}
trap cleanup EXIT INT TERM

log "Iniciando backup de $MONGO_DB en $BACKUP_DIR"
mongodump --uri="$MONGO_URI" --db="$MONGO_DB" --archive="$temporary" --gzip
[[ -s "$temporary" ]] || die "mongodump produjo un archivo vacío. ¿Existe la base $MONGO_DB?"

if [[ "$ENCRYPTION" == "age" ]]; then
  archive="$BACKUP_DIR/$base.age"
  [[ ! -e "$archive" ]] || die "Ya existe $archive. Espera un segundo y reintenta."
  age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$archive.partial" "$temporary"
else
  archive="$BACKUP_DIR/$base.gpg"
  [[ ! -e "$archive" ]] || die "Ya existe $archive. Espera un segundo y reintenta."
  gpg --batch --yes --trust-model always \
    --encrypt --recipient "$BACKUP_GPG_RECIPIENT" \
    --output "$archive.partial" "$temporary"
fi

mv -- "$archive.partial" "$archive"
rm -f -- "$temporary"
chmod 600 "$archive"

[[ -s "$archive" ]] || die "El backup cifrado quedó vacío."

(
  cd "$BACKUP_DIR"
  sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256"
)
chmod 600 "$archive.sha256"

bytes="$(stat -c %s "$archive")"
sha256="$(awk '{print $1}' "$archive.sha256")"
mongodump_version="$(mongodump --version 2>/dev/null | head -n 1 || true)"

cat > "$archive.json" <<EOF
{
  "created_at": "$(json_escape "$created_at")",
  "database": "$(json_escape "$MONGO_DB")",
  "file": "$(json_escape "$(basename "$archive")")",
  "bytes": $bytes,
  "sha256": "$(json_escape "$sha256")",
  "encryption": "$(json_escape "$ENCRYPTION")",
  "mongodump_version": "$(json_escape "$mongodump_version")"
}
EOF
chmod 600 "$archive.json"

log "Backup cifrado: $archive ($bytes bytes, sha256 $sha256)"

if (( RETENTION )); then
  retain_backups() {
    local keep_days="$1"
    local keep_min="$2"
    local -a files=()
    mapfile -t files < <(
      find "$BACKUP_DIR" -maxdepth 1 -type f \
        \( -name 'krakenges-*.dump.gz.age' -o -name 'krakenges-*.dump.gz.gpg' \) \
        -printf '%f\n' | sort
    )

    local total="${#files[@]}"
    (( total > keep_min )) || return 0

    local cutoff
    cutoff="$(date -u -d "-${keep_days} days" +%s)"
    local index file mtime
    for ((index = 0; index < total - keep_min; index++)); do
      file="${files[$index]}"
      mtime="$(stat -c %Y "$BACKUP_DIR/$file")"
      if (( mtime < cutoff )); then
        rm -f -- "$BACKUP_DIR/$file" "$BACKUP_DIR/$file.sha256" "$BACKUP_DIR/$file.json"
        log "Retención: eliminado $file"
      fi
    done
  }

  if ! retain_backups "$BACKUP_KEEP_DAYS" "$BACKUP_KEEP_MIN"; then
    log "AVISO: no se pudo aplicar la retención; el backup nuevo está intacto."
  fi
fi

log "Backup terminado."
