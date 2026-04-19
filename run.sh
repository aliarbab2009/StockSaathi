#!/usr/bin/env bash
# =============================================================================
# StockSaathi — Backend launcher (bash)
# =============================================================================
set -e

PYEXE="/c/Users/$USER/AppData/Local/Programs/Python/Python313/python.exe"
[ -x "$PYEXE" ] || PYEXE="python3"
command -v "$PYEXE" >/dev/null 2>&1 || PYEXE="python"

cd "$(dirname "$0")"

# Find free port
for P in 7340 7341 7342 7343 7344 7345 7346 7347 7348 7349 7350 7351 7352 7353; do
  if ! (echo > /dev/tcp/127.0.0.1/$P) >/dev/null 2>&1; then
    PORT=$P
    break
  fi
done
PORT="${PORT:-7350}"

export STOCKSAATHI_PORT="$PORT"
echo ""
echo "  ====================================================="
echo "           StockSaathi backend + frontend"
echo "  ====================================================="
echo "   http://127.0.0.1:${PORT}/"
echo "   Ctrl+C to stop."
echo ""

(sleep 2 && (xdg-open "http://127.0.0.1:${PORT}/" 2>/dev/null || open "http://127.0.0.1:${PORT}/" 2>/dev/null || start "http://127.0.0.1:${PORT}/" 2>/dev/null || true)) &

exec "$PYEXE" backend.py
