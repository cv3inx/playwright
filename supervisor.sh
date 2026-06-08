#!/bin/bash
# Supervisor: runs the bundled turnstile-solver in the background and the
# Playwright API in the foreground. Either process dying terminates the
# container so the orchestrator (HF/Docker) restarts cleanly.

set -uo pipefail

API_PID=""
SOLVER_PID=""

shutdown() {
  echo "[supervisor] shutting down..."
  [ -n "$API_PID" ] && kill -TERM "$API_PID" 2>/dev/null || true
  [ -n "$SOLVER_PID" ] && kill -TERM "$SOLVER_PID" 2>/dev/null || true
  wait 2>/dev/null
  exit 0
}
trap shutdown SIGTERM SIGINT

# --- Start solver in background ---
echo "[supervisor] starting turnstile-solver on :${SOLVER_PORT:-9988}..."
(
  cd /app/solver
  rm -f /tmp/.X*-lock /tmp/.X11-unix/X* 2>/dev/null || true
  PORT="${SOLVER_PORT:-9988}" CAMOUFOX_HEADLESS="${CAMOUFOX_HEADLESS:-virtual}" \
    python3 service.py 2>&1 | sed 's/^/[solver] /'
) &
SOLVER_PID=$!

# --- Wait briefly for solver to bind, then start API ---
echo "[supervisor] waiting for solver health..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${SOLVER_PORT:-9988}/health" >/dev/null 2>&1; then
    echo "[supervisor] solver healthy after ${i}s"
    break
  fi
  if ! kill -0 "$SOLVER_PID" 2>/dev/null; then
    echo "[supervisor] solver died during boot — continuing without it"
    SOLVER_PID=""
    break
  fi
  sleep 1
done

# --- Start API in foreground ---
echo "[supervisor] starting playwright-api on :${PORT:-7860}..."
bun /app/server.js 2>&1 | sed 's/^/[api] /' &
API_PID=$!

# Wait for either process to exit.
wait -n "$API_PID" ${SOLVER_PID:+$SOLVER_PID} 2>/dev/null
EXIT_CODE=$?
echo "[supervisor] one process exited (status=$EXIT_CODE), shutting down others"
shutdown
