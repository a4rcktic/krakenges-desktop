#!/usr/bin/env bash
# Diagnóstico + backup de MongoDB para el deploy de Kraken Ges.
# Lo ejecuta root en la VPS. Solo lee y hace un dump; no modifica datos.
set -uo pipefail

TS="${1:-manual}"
DEST="/opt/krakenges/backups/mongo.${TS}"
mkdir -p "$DEST"
chmod 700 "$DEST"

echo "=== dbs visibles sin autenticación ==="
mongosh --quiet --eval 'db.adminCommand({listDatabases:1}).databases.forEach(d=>print(d.name + "  " + (d.sizeOnDisk/1048576).toFixed(1) + " MB"))' 2>&1 | head -20

echo
echo "=== probando acceso con las credenciales del .env de la app ==="
# Extrae usuario/host/db de MONGODB_URI sin imprimirla.
URI=$(grep -E '^MONGODB_URI=' /opt/krakenges/backend/.env | cut -d= -f2- | tr -d '"'"'"' ')
if [ -z "$URI" ]; then
  echo "no se pudo leer MONGODB_URI del .env"
  exit 1
fi
echo "URI leida (longitud ${#URI}, valor oculto)"

DBNAME=$(printf '%s' "$URI" | sed -E 's#.*/([^?]+).*#\1#')
echo "base de datos de la app: ${DBNAME}"

echo
echo "=== colecciones en ${DBNAME} ==="
mongosh --quiet "$URI" --eval 'db.getCollectionNames().forEach(c=>{print("  - " + c + " : " + db.getCollection(c).countDocuments() + " docs")})' 2>&1 | head -30

echo
echo "=== cuantos perfiles tienen proxy guardado (lo que NO deberia haber) ==="
mongosh --quiet "$URI" --eval '
const n = db.profiles.countDocuments({ proxy: { $exists: true, $nin: [null, ""] } });
print("perfiles con campo proxy: " + n);
const total = db.profiles.countDocuments({});
print("perfiles totales: " + total);
const conCampo = db.profiles.countDocuments({ proxy: { $exists: true } });
print("perfiles con el campo proxy presente (aunque vacio): " + conCampo);
' 2>&1 | head -20

echo
echo "=== mongodump real ==="
rm -f "$DEST/mongodump.gz"
if mongodump --uri="$URI" --gzip --archive="$DEST/mongodump.gz" 2>&1 | tail -3; then
  SZ=$(stat -c%s "$DEST/mongodump.gz")
  echo "dump: $DEST/mongodump.gz (${SZ} bytes)"
  if [ "$SZ" -lt 1000 ]; then
    echo "AVISO: el dump es sospechosamente pequeno. Verificar antes de continuar."
  else
    echo "backup de Mongo OK"
  fi
else
  echo "FALLO el mongodump. NO continuar con el deploy."
  exit 1
fi
