#!/usr/bin/env bash
# Añade al .env de produccion las claves que faltan, genera SESSION_SECRET
# en la propia VPS (el valor NUNCA sale de aqui).
set -euo pipefail
ENV=/opt/krakenges/backend/.env

gen() { openssl rand -hex 32; }

add_if_missing() {
  local key="$1" val="$2"
  if sudo -n grep -qE "^${key}=" "$ENV" 2>/dev/null; then
    echo "  $key ya existe (no se toca)"
  else
    printf '%s=%s\n' "$key" "$val" | sudo -n tee -a "$ENV" >/dev/null
    echo "  $key añadida"
  fi
}

echo "=== claves actuales (solo nombres) ==="
sudo -n grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV" | tr -d '=' | sed 's/^/  - /'

echo
echo "=== añadiendo las que faltan ==="
# SESSION_SECRET: la usa proxyCipher como fallback para cifrar proxies.
# Antes caia a JWT_SECRET, asi que rotar JWT descifraba los proxies guardados.
add_if_missing SESSION_SECRET "$(gen)"
add_if_missing JWT_EXPIRES_IN "15m"
add_if_missing LOG_LEVEL "info"
add_if_missing LOG_DIR "logs"

# KRAKENGES_PROXY_ENCRYPTION_KEY: clave propia para el cifrado de proxies legacy.
#NO es obligatoria (SESSION_SECRET ya cubre), pero desacopla los dos dominios.
add_if_missing KRAKENGES_PROXY_ENCRYPTION_KEY "b64:$(gen | xxd -r -p | base64)"

echo
echo "=== resultado (solo nombres) ==="
sudo -n grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV" | tr -d '=' | sed 's/^/  - /'

echo
echo "=== permisos (deben seguir en 0600 y el owner correcto) ==="
ls -la "$ENV"
sudo -n chown krakenges:krakenges "$ENV"
sudo -n chmod 600 "$ENV"
ls -la "$ENV"
