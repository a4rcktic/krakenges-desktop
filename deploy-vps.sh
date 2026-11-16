#!/usr/bin/env bash
# ============================================================================
# Kraken Ges — Deploy del backend a la VPS
# ============================================================================
# Reemplaza /opt/krakenges/backend por el código del repo, compilando antes.
#
# Salvaguardas:
#   - Backup de .env, .keys y Mongo: YA HECHOS en /opt/krakenges/backups
#   - .env, .keys y node_modules NUNCA se tocan (excluidos del rsync)
#   - Si falla el build, no se reinicia el servicio y no se sincroniza
#   - Si falla el health check tras reiniciar, se hace rollback del dist
# ============================================================================
set -euo pipefail

REPO_SRC="${1:?falta la ruta del repo local}"
DEP=/opt/krakenges/backend
SVC=krakenges-backend.service
TS=$(date +%Y%m%d-%H%M%S)

echo "=== 1. Stage: subir el codigo a /tmp (sin tocar produccion aun) ==="
STAGE=/tmp/krakenges-deploy-$TS
mkdir -p "$STAGE"
rsync -a --delete \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='logs' \
  --exclude='.env' \
  --exclude='.keys' \
  "$REPO_SRC/" "$STAGE/"
echo "stage en $STAGE"
echo "--- contenido subido ---"
ls -la "$STAGE" | head -20

echo
echo "=== 2. Compilar en la stage (si falla, aqui se para) ==="
cd "$STAGE"
npm ci --no-audit --no-fund --silent || npm install --no-audit --no-fund --silent
npx tsc --noEmit
npm run build
echo "build OK: $(find dist -name '*.js' | wc -l) ficheros .js"

echo
echo "=== 3. Comprobar que el middleware anti-proxy viene en el codigo nuevo ==="
if grep -q 'delete req.body.proxy' src/routes/profiles.ts; then
  echo "OK: el middleware anti-proxy esta presente"
else
  echo "AVISO: el middleware anti-proxy NO esta en el codigo que se va a desplegar"
fi

echo
echo "=== 4. Guardar el dist actual para poder hacer rollback ==="
if [ -d "$DEP/dist" ]; then
  sudo -n cp -a "$DEP/dist" "/opt/krakenges/backups/dist.${TS}.bak"
  echo "dist actual guardado en /opt/krakenges/backups/dist.${TS}.bak"
fi

echo
echo "=== 5. Sincronizar a produccion (excluye .env, .keys, node_modules) ==="
sudo -n rsync -a --delete \
  --exclude='.env' \
  --exclude='.keys' \
  --exclude='node_modules' \
  --exclude='logs' \
  --exclude='.git' \
  --exclude='dist.old-*' \
  --exclude='backups' \
  --exclude='release.json' \
  --exclude='.npmrc' \
  "$STAGE/" "$DEP/"

sudo -n chown -R krakenges:krakenges "$DEP/src" "$DEP/dist" "$DEP/package.json" "$DEP/package-lock.json" "$DEP/tsconfig.json" "$DEP/scripts" 2>/dev/null || \
  sudo -n chown -R krakenges:krakenges "$DEP/src" "$DEP/dist" "$DEP/package.json" "$DEP/package-lock.json" "$DEP/tsconfig.json"

echo
echo "=== 6. Permisos del .env/.keys intactos? ==="
ls -la "$DEP/.env" "$DEP/.keys" 2>&1 | head -5

echo
echo "=== 7. Reiniciar el servicio ==="
sudo -n systemctl restart $SVC
sleep 5

echo "--- estado ---"
sudo -n systemctl is-active $SVC
sudo -n systemctl is-active mongod

echo
echo "=== 8. Health check ==="
if curl -sf --max-time 8 http://127.0.0.1:8010/health; then
  echo ""
  echo "HEALTH OK"
else
  echo ""
  echo "FALLO el health check. Haciendo rollback del dist..."
  if [ -d "/opt/krakenges/backups/dist.${TS}.bak" ]; then
    sudo -n rm -rf "$DEP/dist"
    sudo -n cp -a "/opt/krakenges/backups/dist.${TS}.bak" "$DEP/dist"
    sudo -n chown -R krakenges:krakenges "$DEP/dist"
    sudo -n systemctl restart $SVC
    sleep 5
    echo "rollback hecho. Estado:"
    sudo -n systemctl is-active $SVC
    curl -sf --max-time 8 http://127.0.0.1:8010/health && echo "" || echo "sigue sin responder: MIRAR LOS LOGS"
  fi
  exit 1
fi

echo
echo "=== 9. Verificar que la version desplegada es la nueva ==="
grep -q 'delete req.body.proxy' "$DEP/src/routes/profiles.ts" \
  && echo "OK: middleware anti-proxy desplegado" \
  || echo "AVISO: middleware anti-proxy no encontrado en produccion"

echo
echo "=== 10. Logs recientes ==="
sudo -n journalctl -u $SVC -n 15 --no-pager | tail -15

echo
echo "=== DEPLOY COMPLETADO ($TS) ==="
echo "stage eliminado manualmente si ya no hace falta: sudo rm -rf $STAGE"
