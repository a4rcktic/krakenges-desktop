#!/usr/bin/env bash
# Provisiona el VPS para servir los jobs Linux (ubuntu:22.04) y Arch (archlinux)
# del build-desktop.yml como runner self-hosted con etiquetas "self-hosted,Linux".
# Requisito: el VPS ya tiene el agente de GitHub instalado en ~/actions-runner
# (el mismo que sirve deploy-backend). Este script solo añade DOCKER + ETIQUETAS.
set -euo pipefail

REPO="${1:?uso: $0 <owner/repo>}" # ej: TU_USUARIO/TU_REPO

# 1. Asegurar Docker disponible para el usuario del runner
if ! command -v docker >/dev/null 2>&1; then
  echo "[setup] Instalando Docker..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker.io
  sudo systemctl enable --now docker
fi

RUNNER_USER="${RUNNER_USER:-ubuntu}"
if ! id -nG "$RUNNER_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "[setup] Añadiendo $RUNNER_USER al grupo docker..."
  sudo usermod -aG docker "$RUNNER_USER"
fi

RUNNER_DIR="${RUNNER_DIR:-/home/$RUNNER_USER/actions-runner}"
[ -f "$RUNNER_DIR/.runner" ] || { echo "ERROR: no existe $RUNNER_DIR/.runner"; exit 1; }

# 2. Reconfigurar el runner con las etiquetas (self-hosted, linux) — replace sin perder datos
cd "$RUNNER_DIR"
TOKEN=$(curl -sS -X POST -H "Authorization: Bearer ${GH_TOKEN}" \
  "https://api.github.com/repos/${REPO}/actions/runners/registration-token" | jq -r .token)
# GH_TOKEN debe tener scope repo/actions en $REPO (se obtiene con: gh auth token)

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: no se pudo generar el registration token de $REPO"
  exit 1
fi

echo "[setup] Re-registrando runner con etiquetas self-hosted,Linux..."
sudo systemctl stop "actions.runner.*.service" >/dev/null 2>&1 || true
sudo -u "$RUNNER_USER" ./config.sh --unattended --replace \
  --url "https://github.com/$REPO" \
  --token "$TOKEN" \
  --labels "self-hosted,Linux" \
  --work _work
sudo -u "$RUNNER_USER" ./svc.sh install && sudo -u "$RUNNER_USER" ./svc.sh start || \
  sudo systemctl restart "actions.runner.*.service"

echo "[setup] OK — runner listo para jobs { self-hosted, linux } (Linux y Arch)."
echo "[setup] Verificación:"
sudo -u "$RUNNER_USER" ./run.sh --version >/dev/null 2>&1 || true
sudo -u "$RUNNER_USER" ./config.sh --help >/dev/null 2>&1 || true