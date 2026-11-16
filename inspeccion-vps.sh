#!/usr/bin/env bash
# ============================================================================
# Kraken Ges — Inspección del backend en la VPS (SOLO LECTURA)
# ============================================================================
# Este script NO modifica nada: no escribe, no reinicia, no borra. Solo
# informa de cómo está montado el backend en producción, para poder comparar
# con el código local antes de desplegar.
#
# CÓMO USAR (en la VPS, como el usuario que despliega):
#   scp inspeccion-vps.sh ubuntu@TU_VPS:/tmp/
#   ssh ubuntu@TU_VPS 'bash /tmp/inspeccion-vps.sh'
#
# Para que la salida sea legible en un solo bloque, redirigir a fichero:
#   ssh ubuntu@TU_VPS 'bash /tmp/inspeccion-vps.sh' > /tmp/inspeccion.txt 2>&1
#
# ⚠️  Revisa la salida antes de compartir: puede contener rutas internas,
#     versiones y nombres de usuario (no debería contener contraseñas, ya que
#     este script nunca las imprime).
# ============================================================================

set -uo pipefail   # NO usa -e: queremos que siga aunque un comando falle

sep() { printf '\n===== %s =====\n' "$1"; }

sep "1. SISTEMA"
echo "host:   $(hostname)"
echo "kernel: $(uname -srm)"
if [ -f /etc/os-release ]; then . /etc/os-release; echo "os:     ${PRETTY_NAME:-?}"; fi
echo "fecha:  $(date -Is)"

sep "2. NODE Y NPM"
echo "node: $(command -v node >/dev/null && node --version || echo 'NO INSTALADO')"
echo "npm:  $(command -v npm  >/dev/null && npm  --version || echo 'NO INSTALADO')"

sep "3. USUARIO ACTUAL"
echo "user:  $(id -un)  (uid=$(id -u))"
echo "sudo:  $(sudo -n true 2>/dev/null && echo 'sin contraseña (passwordless)' || echo 'requiere contraseña')"

sep "4. UBICACIÓN ESPERADA DEL BACKEND"
DEP=/opt/krakenges/backend
if [ -d "$DEP" ]; then
  echo "EXISTE: $DEP"
  echo "--- contenido (1 nivel) ---"
  ls -la "$DEP" 2>/dev/null
  echo "--- .env presente? (solo SÍ/NO y tamaño; NO se imprime) ---"
  if [ -f "$DEP/.env" ]; then
    echo ".env SÍ existe ($(wc -l < "$DEP/.env") líneas, $(stat -c%s "$DEP/.env") bytes)"
    echo "claves definidas (solo nombres):"
    grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$DEP/.env" 2>/dev/null | tr -d '=' | sed 's/^/  - /'
  else
    echo ".env NO existe"
  fi
  echo "--- .keys / claves de licencia ---"
  if [ -d "$DEP/.keys" ]; then
    echo ".keys SÍ existe:"; ls -la "$DEP/.keys" 2>/dev/null
  elif [ -d "$DEP/keys" ]; then
    echo "keys/ SÍ existe:"; ls -la "$DEP/keys" 2>/dev/null
  else
    echo "NO hay .keys/ ni keys/"
  fi
  echo "--- package.json (nombre/versión/scripts) ---"
  if [ -f "$DEP/package.json" ]; then
    node -e "const p=require('$DEP/package.json');console.log('name:',p.name);console.log('version:',p.version);console.log('scripts:',Object.keys(p.scripts||{}).join(' '))" 2>/dev/null \
      || echo "(no se pudo leer con node)"
  fi
  echo "--- dist/ compilado? ---"
  if [ -d "$DEP/dist" ]; then
    echo "dist/ SÍ existe ($(find "$DEP/dist" -name '*.js' | wc -l) ficheros .js)"
  else
    echo "dist/ NO existe"
  fi
  echo "--- node_modules ---"
  if [ -d "$DEP/node_modules" ]; then echo "presente ($(ls "$DEP/node_modules" | wc -l) paquetes)"; else echo "NO existe"; fi
  echo "--- BACKUPS /_logs_ (por si el deploy deja rastros) ---"
  ls -lad "$DEP"/dist.old-* "$DEP"/backups 2>/dev/null || echo "(ninguno)"
else
  echo "NO EXISTE: $DEP   <-- el backend NO está donde el workflow espera"
fi

sep "5. SERVICIO systemd"
if command -v systemctl >/dev/null; then
  echo "--- estado krakenges-backend.service ---"
  systemctl is-active krakenges-backend.service 2>/dev/null || echo "no encontrado/inactivo"
  systemctl is-enabled krakenges-backend.service 2>/dev/null || true
  echo "--- definition (ExecStart / WorkingDirectory / User) ---"
  systemctl show krakenges-backend.service -p ExecStart -p WorkingDirectory -p User -p EnvironmentFile 2>/dev/null
  echo "--- ultimos 20 log lines ---"
  journalctl -u krakenges-backend.service -n 20 --no-pager 2>/dev/null || echo "(sin permisos o sin logs)"
else
  echo "systemd no disponible"
fi

sep "6. MONGODB"
if command -v mongosh >/dev/null; then
  echo "mongosh: $(mongosh --version | head -1)"
elif command -v mongo >/dev/null; then
  echo "mongo: presente"
else
  echo "cliente mongo NO instalado"
fi
systemctl is-active mongod 2>/dev/null && echo "mongod: activo" || echo "mongod: inactivo/no encontrado"
# Intento contar colecciones SIN mostrar credenciales
echo "--- collections (si se puede leer sin credenciales) ---"
mongosh --quiet --eval 'db.getSiblingDB("krakenges").getCollectionNames().forEach(c=>console.log("  - "+c))' 2>/dev/null \
  || echo "no se pudo leer (pide autenticación; normal)"

sep "7. PUERTO 8010 (el que espera el health check)"
if command -v ss >/dev/null; then
  ss -tlnp 2>/dev/null | grep -E ':8010|:4000|:27017' || echo "no escuchando en 8010/4000/27017"
elif command -v netstat >/dev/null; then
  netstat -tlnp 2>/dev/null | grep -E ':8010|:4000|:27017' || echo "no escuchando en 8010/4000/27017"
fi
echo "--- health check local ---"
curl -sf --max-time 5 http://127.0.0.1:8010/health 2>/dev/null && echo "" || echo "no responde en 127.0.0.1:8010/health"

sep "8. NGINX / PROXY (si está)"
if command -v nginx >/dev/null; then
  echo "nginx: instalado"
  nginx -t 2>&1 | head -3
  echo "--- vhosts que mencionen 8010 ---"
  grep -rl "8010" /etc/nginx/ 2>/dev/null | head -5 || echo "ninguno"
else
  echo "nginx NO instalado"
fi

sep "9. ESPACIO EN DISCO"
df -h / /opt 2>/dev/null | head -5

sep "10. RESUMEN RÁPIDO"
printf '%-45s %s\n' "/opt/krakenges/backend" "$([ -d /opt/krakenges/backend ] && echo OK || echo FALTA)"
printf '%-45s %s\n' ".env" "$([ -f /opt/krakenges/backend/.env ] && echo OK || echo FALTA)"
printf '%-45s %s\n' ".keys/ o keys/" "$([ -d /opt/krakenges/backend/.keys ] || [ -d /opt/krakenges/backend/keys ] && echo OK || echo FALTA)"
printf '%-45s %s\n' "krakenges-backend.service" "$(systemctl is-active krakenges-backend.service 2>/dev/null || echo FALTA)"
printf '%-45s %s\n' "mongod" "$(systemctl is-active mongod 2>/dev/null || echo FALTA)"
printf '%-45s %s\n' "health 127.0.0.1:8010" "$(curl -sf --max-time 5 http://127.0.0.1:8010/health >/dev/null 2>&1 && echo OK || echo FALTA)"

echo
echo "===== FIN (script de solo lectura: no se modificó nada) ====="
