#!/usr/bin/env bash
# ==============================================================================
# KRAKEN GES AUTONOMOUS GOOGLE CHROMIUM ENGINE PROVISIONER
# Descarga e instala el motor Google Chrome oficial standalone en bin/windows y bin/linux
# Fuente: Google Chrome for Testing (Google Labs CDN oficial)
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TARGET_OS="${1:-all}" # "windows", "linux", o "all"

echo "=== [Engine Provisioner] Consultando Google Labs CDN oficial ==="

API_URL="https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
JSON_DATA=$(curl -s "$API_URL")

VERSION=$(echo "$JSON_DATA" | node -e "
  const stdin = require('fs').readFileSync(0, 'utf-8');
  const data = JSON.parse(stdin);
  console.log(data.channels.Stable.version);
")

echo ">> Versión estable oficial de Google Chrome identificada: $VERSION"

download_and_extract() {
  local PLATFORM="$1"
  local DEST_DIR="$2"
  local ZIP_NAME="chrome-$PLATFORM.zip"
  local DOWNLOAD_URL=$(echo "$JSON_DATA" | node -e "
    const stdin = require('fs').readFileSync(0, 'utf-8');
    const data = JSON.parse(stdin);
    const item = data.channels.Stable.downloads.chrome.find(x => x.platform === '$PLATFORM');
    if (!item) process.exit(1);
    console.log(item.url);
  ")

  echo "------------------------------------------------------------------"
  echo ">> Descargando Motor Autónomo Google Chrome para $PLATFORM..."
  echo "   URL: $DOWNLOAD_URL"
  echo "   Destino: $DEST_DIR"

  mkdir -p "$DEST_DIR"
  TMP_DIR=$(mktemp -d)
  
  curl -L "$DOWNLOAD_URL" -o "$TMP_DIR/$ZIP_NAME" --progress-bar
  
  echo ">> Desempaquetando archivos del motor..."
  unzip -q -o "$TMP_DIR/$ZIP_NAME" -d "$TMP_DIR"
  
  # Copiar contenido de chrome-$PLATFORM al directorio destino
  cp -rf "$TMP_DIR/chrome-$PLATFORM/"* "$DEST_DIR/"
  
  rm -rf "$TMP_DIR"
  echo ">> Motor para $PLATFORM instalado exitosamente en $DEST_DIR"
}

if [ "$TARGET_OS" = "windows" ] || [ "$TARGET_OS" = "all" ]; then
  download_and_extract "win64" "$ROOT_DIR/bin/windows"
fi

if [ "$TARGET_OS" = "linux" ] || [ "$TARGET_OS" = "all" ]; then
  download_and_extract "linux64" "$ROOT_DIR/bin/linux"
  if [ -f "$ROOT_DIR/bin/linux/chrome" ]; then
    chmod +x "$ROOT_DIR/bin/linux/chrome"
  fi
fi

echo "=================================================================="
echo ">> Provisionamiento de Motor Autónomo Completado con Éxito."
echo "   La app ahora ejecutará su propio motor de Google dedicado"
echo "   sin interactuar con los navegadores instalados por el usuario."
echo "=================================================================="
