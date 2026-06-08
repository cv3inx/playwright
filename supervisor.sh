#!/bin/bash
# Supervisor for the playwright-api container.
#
# Two modes:
#
#   1) Standalone (HF Space): TURNSTILE_SOLVER_URL points at 127.0.0.1 /
#      localhost. The bundled Python solver is started in the background
#      and we wait for it before launching the API.
#
#   2) Compose: TURNSTILE_SOLVER_URL points at the sibling `turnstile-solver`
#      service on the internal Docker network. We skip the bundled solver
#      entirely (saves boot time and avoids the dep-install footgun) and
#      just wait for the remote one to be healthy.

set -uo pipefail

API_PID=""
SOLVER_PID=""
SOLVER_PORT="${SOLVER_PORT:-9988}"
SOLVER_URL="${TURNSTILE_SOLVER_URL:-http://127.0.0.1:${SOLVER_PORT}}"

shutdown() {
  echo "[supervisor] shutting down..."
  [ -n "$API_PID" ] && kill -TERM "$API_PID" 2>/dev/null || true
  [ -n "$SOLVER_PID" ] && kill -TERM "$SOLVER_PID" 2>/dev/null || true
  wait 2>/dev/null
  exit 0
}
trap shutdown SIGTERM SIGINT

# Decide whether the solver lives in this container.
case "$SOLVER_URL" in
  *127.0.0.1*|*localhost*)
    BUNDLED_SOLVER=1 ;;
  *)
    BUNDLED_SOLVER=0 ;;
esac

if [ "$BUNDLED_SOLVER" = "1" ]; then
  if [ -f /app/solver/service.py ] && command -v python3 >/dev/null 2>&1; then
    if python3 -c "import aiohttp" 2>/dev/null; then
      echo "[supervisor] starting bundled turnstile-solver on :${SOLVER_PORT}..."
      (
        cd /app/solver
        rm -f /tmp/.X*-lock /tmp/.X11-unix/X* 2>/dev/null || true
        PORT="${SOLVER_PORT}" CAMOUFOX_HEADLESS="${CAMOUFOX_HEADLESS:-virtual}" \
          python3 service.py 2>&1 | sed 's/^/[solver] /'
      ) &
      SOLVER_PID=$!
    else
      echo "[supervisor] solver deps missing (aiohttp) — bundled solver disabled"
    fi
  else
    echo "[supervisor] bundled solver not present in image — skipping"
  fi
else
  echo "[supervisor] external solver configured: $SOLVER_URL — not starting bundled"
fi

echo "[supervisor] waiting for solver health at ${SOLVER_URL}..."
SOLVER_READY=0
for i in $(seq 1 60); do
  if curl -fsS "${SOLVER_URL%/}/health" >/dev/null 2>&1; then
    echo "[supervisor] solver healthy after ${i}s"
    SOLVER_READY=1
    break
  fi
  if [ "$BUNDLED_SOLVER" = "1" ] && [ -n "$SOLVER_PID" ] && ! kill -0 "$SOLVER_PID" 2>/dev/null; then
    echo "[supervisor] bundled solver died during boot — continuing without it"
    SOLVER_PID=""
    break
  fi
  sleep 1
done

if [ "$SOLVER_READY" = "0" ]; then
  echo "[supervisor] solver did not become healthy in 60s — API will start anyway"
  echo "[supervisor]   captcha.solveTurnstile() will fall back to local click only"
fi

echo "[supervisor] starting playwright-api on :${PORT:-7860}..."
bun /app/server.js 2>&1 | sed 's/^/[api] /' &
API_PID=$!

wait -n "$API_PID" ${SOLVER_PID:+$SOLVER_PID} 2>/dev/null
EXIT_CODE=$?
echo "[supervisor] one process exited (status=$EXIT_CODE), shutting down others"
shutdown
