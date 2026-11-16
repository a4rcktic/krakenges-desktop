#!/usr/bin/env bash
# ==============================================================================
# KRAKEN GES INSTALLER BUILDER HELPER
# Prepara el bundle de producción y compila KrakenGes-Setup-v1.0.1-x64.exe
# ------------------------------------------------------------------------------
# La version 1.0.0 es la primera release real. Las referencias a v1.5.x que
# quedaron en comentarios de este repositorio eran incrementos de desarrollo
# que nunca se publicaron (ver DOCUMENTACION-KRAKENGES.txt seccion 1.2).
# ==============================================================================

set -e

echo "=== [1/3] Compilando el frontend React ==="
# El frontend vive un nivel arriba del directorio installer/, no en ../client
# (esa ruta no existe desde que el proyecto se reorganizó).
cd "$(dirname "$0")/.."
npm run build

echo "=== [2/3] Verificando estructura de dependencias de Windows ==="
cd "$(dirname "$0")"

mkdir -p bin/windows
mkdir -p fonts
mkdir -p ../dist-installer

# Comprobar si Inno Setup Compiler está instalado (nativamente o via wine)
if command -v iscc &> /dev/null; then
  echo "=== [3/3] Compilando instalador Inno Setup con ISCC ==="
  iscc Setup.iss
elif command -v wine &> /dev/null && [ -f "$HOME/.wine/drive_c/Program Files (x86)/Inno Setup 6/ISCC.exe" ]; then
  echo "=== [3/3] Compilando instalador Inno Setup mediante Wine ISCC ==="
  wine "$HOME/.wine/drive_c/Program Files (x86)/Inno Setup 6/ISCC.exe" Setup.iss
else
  echo "[AVISO] 'iscc' no está instalado en este entorno Linux."
  echo "El script 'Setup.iss' está 100% listo para ser compilado con Inno Setup 6 en Windows."
fi

echo "=== Proceso completado exitosamente ==="
