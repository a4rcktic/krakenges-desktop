#!/usr/bin/env bash
# Restauración de un backup cifrado de Kraken Ges.
#
# Por defecto NO escribe nada: muestra el plan y exige --yes. Para validar el
# fichero sin MongoDB usa --check-only.
#
# Uso:
#   ./krakenges-restore.sh --file /var/backups/krakenges/krakenges-....dump.gz.age --check-only
#   ./krakenges-restore.sh --file ... --target-db krakenges-restore --dry-run
#   ./krakenges-restore.sh --file ... --yes
#
# Variables:
#   BACKUP_AGE_IDENTITY   Identidad privada age. Obligatoria para .age.
#   TARGET_URI            URI de MongoDB destino (o MONGO_URI).
#   SOURCE_DB             Base guardada en el backup. Se lee del .json si falta.
#   TARGET_DB             Base destino. Por defecto, la misma que SOURCE_DB.
#   ALLOW_PLAINTEXT=1     Permite restaurar un .dump.gz antiguo sin cifrar.

set -Eeuo pipefail
umask 077

usage() {
  cat <<'EOF'
Restaura un backup de MongoDB de Kraken Ges.

Opciones:
  --file <fichero>       Backup .age, .gpg o .dump.gz (obligatorio).
  --target-uri <uri>     URI destino. También TARGET_URI o MONGO_URI.
  --source-db <nombre>   Base guardada en el backup.
  --target-db <nombre>   Base destino. Por defecto, igual que la origen.
  --check-only           Descifra y valida el gzip, sin MongoDB.
  --dry-run              Ejecuta mongorestore --dryRun, sin escribir.
  --yes                  Confirma la restauración real.
  --drop                 Borra las colecciones destino antes de restaurar.
  -h, --help             Muestra esta ayuda.

Ejemplos:
  ./krakenges-restore.sh --file /ruta/backup.age --check-only
  ./krakenges-restore.sh --file /ruta/backup.age --target-db krakenges-restore --dry-run
  ./krakenges-restore.sh --file /ruta/backup.age --yes
EOF
}

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

FILE=""
TARGET_URI="${TARGET_URI:-${MONGO_URI:-}}"
SOURCE_DB="${SOURCE_DB:-}"
TARGET_DB="${TARGET_DB:-}"
CHECK_ONLY=0
DRY_RUN=0
ASSUME_YES=0
DROP=0

while (( $# > 0 )); do
  argument="$1"
  case "$argument" in
    --file)
      (( $# >= 2 )) || die "Falta el valor de --file."
      FILE="$2"
      shift 2
      ;;
    --file=*) FILE="${argument#*=}"; shift ;;
    --target-uri)
      (( $# >= 2 )) || die "Falta el valor de --target-uri."
      TARGET_URI="$2"
      shift 2
      ;;
    --target-uri=*) TARGET_URI="${argument#*=}"; shift ;;
    --source-db)
      (( $# >= 2 )) || die "Falta el valor de --source-db."
      SOURCE_DB="$2"
      shift 2
      ;;
    --source-db=*) SOURCE_DB="${argument#*=}"; shift ;;
    --target-db)
      (( $# >= 2 )) || die "Falta el valor de --target-db."
      TARGET_DB="$2"
      shift 2
      ;;
    --target-db=*) TARGET_DB="${argument#*=}"; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --drop) DROP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Opción desconocida: $argument. Usa --help." ;;
  esac
done

[[ -n "$FILE" ]] || die "Falta --file. Usa --help para ver los ejemplos."
[[ -f "$FILE" ]] || die "No existe el backup: $FILE"
[[ -s "$FILE" ]] || die "El backup está vacío: $FILE"

if [[ -f "$FILE.sha256" ]]; then
  log "Verificando checksum..."
  (
    cd "$(dirname "$FILE")"
    sha256sum -c "$(basename "$FILE.sha256")"
  )
else
  log "AVISO: no hay $FILE.sha256; no se puede comprobar la integridad."
fi

temporary_decrypted=""
cleanup() {
  if [[ -n "$temporary_decrypted" ]]; then
    rm -f -- "$temporary_decrypted"
  fi
}
trap cleanup EXIT INT TERM

plaintext=""
case "$FILE" in
  *.age)
    command -v age >/dev/null 2>&1 || die "No está instalado age."
    [[ -n "${BACKUP_AGE_IDENTITY:-}" ]] || die "Define BACKUP_AGE_IDENTITY para descifrar .age."
    [[ -f "$BACKUP_AGE_IDENTITY" ]] || die "No existe la identidad age: $BACKUP_AGE_IDENTITY"
    temporary_decrypted="$(mktemp "${TMPDIR:-/tmp}/krakenges-restore.XXXXXX")"
    log "Descifrando con age..."
    age --decrypt -i "$BACKUP_AGE_IDENTITY" -o "$temporary_decrypted" "$FILE"
    plaintext="$temporary_decrypted"
    ;;
  *.gpg)
    command -v gpg >/dev/null 2>&1 || die "No está instalado gpg."
    temporary_decrypted="$(mktemp "${TMPDIR:-/tmp}/krakenges-restore.XXXXXX")"
    log "Descifrando con GPG..."
    gpg --batch --yes --decrypt --output "$temporary_decrypted" "$FILE"
    plaintext="$temporary_decrypted"
    ;;
  *.dump.gz)
    [[ "${ALLOW_PLAINTEXT:-0}" == "1" ]] || die \
      "El backup no está cifrado. Si es una copia antigua, exporta ALLOW_PLAINTEXT=1."
    plaintext="$FILE"
    ;;
  *)
    die "Extensión no reconocida. Se aceptan .age, .gpg y .dump.gz."
    ;;
esac

[[ -s "$plaintext" ]] || die "El contenido descifrado está vacío."
command -v gzip >/dev/null 2>&1 || die "No está instalado gzip."
gzip -t "$plaintext" || die "El contenido no es un gzip válido; el backup está corrupto."

if (( CHECK_ONLY )); then
  log "Check OK: checksum, descifrado y gzip válidos. No se ha tocado MongoDB."
  exit 0
fi

command -v mongorestore >/dev/null 2>&1 || die "No está instalado mongorestore (paquete mongodb-database-tools)."
[[ -n "$TARGET_URI" ]] || die "Falta TARGET_URI (o MONGO_URI) para restaurar."

if [[ -z "$SOURCE_DB" && -f "$FILE.json" ]]; then
  SOURCE_DB="$(sed -n 's/.*"database"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$FILE.json" | head -n 1)"
fi
SOURCE_DB="${SOURCE_DB:-krakenges}"
TARGET_DB="${TARGET_DB:-$SOURCE_DB}"

[[ "$SOURCE_DB" =~ ^[A-Za-z0-9_-]+$ ]] || die "SOURCE_DB no es un nombre de base válido."
[[ "$TARGET_DB" =~ ^[A-Za-z0-9_-]+$ ]] || die "TARGET_DB no es un nombre de base válido."

restore_args=(--uri="$TARGET_URI" --archive="$plaintext" --gzip)
if (( DROP )); then
  restore_args+=(--drop)
fi
if (( DRY_RUN )); then
  restore_args+=(--dryRun)
fi
if [[ "$SOURCE_DB" != "$TARGET_DB" ]]; then
  restore_args+=(--nsFrom="$SOURCE_DB.*" --nsTo="$TARGET_DB.*")
fi

if (( ! ASSUME_YES && ! DRY_RUN )); then
  log "Restauración preparada, pero no se ha escrito nada."
  printf '  fichero:       %s\n' "$FILE"
  printf '  base origen:   %s\n' "$SOURCE_DB"
  printf '  base destino:  %s\n' "$TARGET_DB"
  printf '  --drop:        %s\n' "$( ((DROP)) && echo si || echo no )"
  log "Detén el backend y repite con --yes. Para probar sin escribir usa --dry-run."
  exit 0
fi

log "Ejecutando mongorestore (destino oculto)..."
mongorestore "${restore_args[@]}"
log "Restauración terminada. Arranca el backend y comprueba /health y los datos."
