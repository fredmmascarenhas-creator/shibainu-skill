#!/usr/bin/env bash
# install-dream-cron.sh — registers the nightly Dream consolidation (03h) on this
# machine, idempotently (re-running replaces the previous shibainu entry).
#
#   bash scripts/install-dream-cron.sh            # install/refresh
#   bash scripts/install-dream-cron.sh --remove   # uninstall
#
# Env honored at install time (baked into the cron line if set):
#   ANTHROPIC_API_KEY  — required for the LLM consolidation + REFLECT pass
#   DREAM_CONTEXT      — clinical|personal|generic
#   SHIBAINU_LOG       — log path (default ~/.openclaw/workspace/memory/dream.log)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER='# shibainu-dream'

if [ "${1:-}" = "--remove" ]; then
  (crontab -l 2>/dev/null | grep -v "$MARKER") | crontab -
  echo "✓ shibainu: cron do Dream removido"
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "✗ node não encontrado no PATH — instale Node.js antes" >&2
  exit 1
fi

DREAM="$SCRIPT_DIR/dream-v2.js"
LOG="${SHIBAINU_LOG:-$HOME/.openclaw/workspace/memory/dream.log}"
mkdir -p "$(dirname "$LOG")"

ENV_PREFIX=""
[ -n "${ANTHROPIC_API_KEY:-}" ] && ENV_PREFIX="ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY "
[ -n "${DREAM_CONTEXT:-}" ]     && ENV_PREFIX="${ENV_PREFIX}DREAM_CONTEXT=$DREAM_CONTEXT "

CRON_LINE="0 3 * * * ${ENV_PREFIX}$NODE_BIN $DREAM >> $LOG 2>&1 $MARKER"
(crontab -l 2>/dev/null | grep -v "$MARKER"; echo "$CRON_LINE") | crontab -

echo "✓ shibainu: Dream agendado às 03h"
echo "  $CRON_LINE"
[ -z "${ANTHROPIC_API_KEY:-}" ] && echo "  ⚠ sem ANTHROPIC_API_KEY no ambiente — Dream vai compactar memória mas pular consolidação LLM e REFLECT"
exit 0
