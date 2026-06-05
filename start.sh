#!/usr/bin/env bash
# ============================================================
#  DLMM Agent — Démarrage complet (bash / Git Bash / WSL)
#
#  USAGE :
#    ./start.sh                  # paper trading autonome + dashboard
#    ./start.sh --supervised     # mode superviseur
#    ./start.sh --dashboard-only # dashboard seul
#    ./start.sh --agent-only     # agent seul
#    ./start.sh --status         # état terminal
# ============================================================

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD="$ROOT/dashboard"

SUPERVISED=0
DASHBOARD_ONLY=0
AGENT_ONLY=0
STATUS=0

for arg in "$@"; do
  case $arg in
    --supervised)     SUPERVISED=1 ;;
    --dashboard-only) DASHBOARD_ONLY=1 ;;
    --agent-only)     AGENT_ONLY=1 ;;
    --status)         STATUS=1 ;;
  esac
done

# ── Vérifications ─────────────────────────────────────────────

if [ ! -d "$ROOT/node_modules" ]; then
  echo ""
  echo "  ❌  node_modules manquant — lance d'abord : npm run setup"
  echo ""
  exit 1
fi

if [ ! -d "$DASHBOARD/node_modules" ]; then
  echo ""
  echo "  ❌  dashboard/node_modules manquant — lance d'abord : npm run setup"
  echo ""
  exit 1
fi

# ── Mode Status ────────────────────────────────────────────────

if [ $STATUS -eq 1 ]; then
  npm run status
  exit 0
fi

# ── Mode Agent seul ───────────────────────────────────────────

if [ $AGENT_ONLY -eq 1 ]; then
  AGENT_FLAGS="--loop"
  [ $SUPERVISED -eq 1 ] && AGENT_FLAGS="--loop --supervised"
  echo ""
  echo "  ▶  Agent paper trading (sans dashboard)"
  echo "     npm run paper -- $AGENT_FLAGS"
  echo ""
  npm run paper -- $AGENT_FLAGS
  exit 0
fi

# ── Mode Dashboard seul ───────────────────────────────────────

if [ $DASHBOARD_ONLY -eq 1 ]; then
  echo ""
  echo "  ▶  Dashboard → http://localhost:3000"
  echo ""
  cd "$DASHBOARD" && npm run dev
  exit 0
fi

# ── Mode complet : Agent + Dashboard ──────────────────────────

AGENT_FLAGS="--loop"
[ $SUPERVISED -eq 1 ] && AGENT_FLAGS="--loop --supervised"
LABEL="autonome"
[ $SUPERVISED -eq 1 ] && LABEL="supervisé (approbations via dashboard)"

echo ""
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║        DLMM Agent — Démarrage complet               ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Mode agent   : $LABEL"
echo "  Dashboard    : http://localhost:3000"
echo ""
echo "  Ctrl+C pour arrêter les deux processus."
echo ""

# Démarre le dashboard en arrière-plan
(cd "$DASHBOARD" && npm run dev) &
DASH_PID=$!

# Délai pour que le dashboard s'initialise avant l'agent
sleep 3

# Démarre l'agent au premier plan (Ctrl+C l'arrête et kill le dashboard)
trap "kill $DASH_PID 2>/dev/null; exit 0" INT TERM

npm run paper -- $AGENT_FLAGS

# Nettoyage si l'agent se termine normalement
kill $DASH_PID 2>/dev/null || true
