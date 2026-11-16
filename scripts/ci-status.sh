#!/usr/bin/env bash
# =============================================================================
# Kraken Ges — estado del CI y del repo
# =============================================================================
# Uso:
#   ./scripts/ci-status.sh          resumen
#   ./scripts/ci-status.sh -w       sigue los runs en curso hasta que acaben
#
# Depende solo de `gh` autenticado. No modifica nada.
# =============================================================================
set -uo pipefail

REPO="${KRAKENGES_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)}"
green=$'\e[32m'; red=$'\e[31m'; yellow=$'\e[33m'; dim=$'\e[2m'; reset=$'\e[0m'

color() {
  case "$1" in
    success) printf '%s%s%s' "$green" "$1" "$reset" ;;
    failure) printf '%s%s%s' "$red" "$1" "$reset" ;;
    cancelled) printf '%s%s%s' "$yellow" "$1" "$reset" ;;
    in_progress) printf '%s%s%s' "$yellow" "$1" "$reset" ;;
    queued) printf '%s%s%s' "$yellow" "$1" "$reset" ;;
    *) printf '%s%s%s' "$dim" "$1" "$reset" ;;
  esac
}

show_runs() {
  echo "──────────────────────────────────────────────"
  echo " Kraken Ges · $REPO"
  echo "──────────────────────────────────────────────"
  echo
  printf ' %-8s %-34s %s\n' "ESTADO" "WORKFLOW" "COMMIT"
  printf ' %-8s %-34s %s\n' "──────" "────────" "──────"

  gh run list --repo "$REPO" --limit 12 \
    --json conclusion,status,workflowName,headSha,displayTitle 2>/dev/null |
  jq -c '.[]' 2>/dev/null |
  while read -r run; do
    conclusion=$(jq -r '.conclusion // .status // "desconocido"' <<<"$run")
    wf=$(jq -r '.workflowName' <<<"$run")
    sha=$(jq -r '.headSha[0:7]' <<<"$run")
    title=$(jq -r '.displayTitle' <<<"$run" | cut -c1-40)
    # El color se aplica al estado ya con el ancho fijo, para que el padding
    # no se descuadre por los codigos de color.
    printf ' %-19s%-34s %s %s%s%s\n' "$(color "$conclusion")" "$wf" "$sha" "$dim" "$title" "$reset"
  done
}

show_jobs() {
  local rid="$1"
  echo
  echo " Jobs del run $rid:"
  # Ojo: la API de GitHub deja conclusion Y status vacios mientras un job
  # corre, asi que no sirven para saber si avanza. Se cae a steps[]: el que
  # tenga conclusion vacio es el que esta en ejecucion.
  gh run view "$rid" --repo "$REPO" --json jobs 2>/dev/null |
    jq -r '.jobs[] |
      (.conclusion // .status) as $c
      | (if $c == null or $c == "" then
           (if ([.steps[] | select(.conclusion == null or .conclusion == "")] | length) > 0
            then "en curso" else "pendiente" end)
         else $c end) as $state
      | $state + "|" + .name' 2>/dev/null |
    while IFS='|' read -r state name; do
      pad=$(printf "%$(( 18 - ${#state} ))s" '')
      printf '   %s%s%s%s\n' "$(color "$state")" "$pad" "$name" "$reset"
    done
}

failures_detail() {
  local failed
  failed=$(gh run list --repo "$REPO" --limit 5 \
    --json conclusion,databaseId -q '.[] | select(.conclusion=="failure") | .databaseId' 2>/dev/null)
  [ -z "$failed" ] && return 0

  echo
  echo "──────────────────────────────────────────────"
  echo " Últimos fallos"
  echo "──────────────────────────────────────────────"
  for rid in $failed; do
    wf=$(gh run view "$rid" --repo "$REPO" --json workflowName -q '.workflowName' 2>/dev/null)
    echo
    echo " $wf (run $rid):"
    gh run view "$rid" --repo "$REPO" --log-failed 2>/dev/null |
      sed 's/\x1b\[[0-9;]*m//g' |
      grep -E "error\[E[0-9]+\]|^.*Error: |##\[error\]|test result:|could not compile" |
      sed 's/^.*Z //' | sort -u | head -8 | sed 's/^/   /'
  done
}

show_runs
# Se itera sobre lineas completas (no sobre palabras): los nombres de workflow
# llevan espacios y se romperian con un for por defecto.
gh run list --repo "$REPO" --limit 6 --json status,databaseId 2>/dev/null |
  jq -r '.[] | select(.status=="in_progress") | .databaseId' 2>/dev/null |
  while read -r rid; do
    [ -n "$rid" ] && show_jobs "$rid"
  done
failures_detail

if [ "${1:-}" = "-w" ]; then
  echo
  echo " Siguiendo los runs en curso (Ctrl-C para salir)…"
  while true; do
    running=$(gh run list --repo "$REPO" --limit 6 --json status -q '.[] | select(.status=="in_progress") | .status' 2>/dev/null | wc -l)
    [ "$running" -eq 0 ] && break
    sleep 30
  done
  echo " Todos los runs han terminado."
  show_runs
  failures_detail
fi
