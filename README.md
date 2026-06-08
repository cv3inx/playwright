---
title: Playwright
emoji: 🔥
colorFrom: green
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# Playwright API

Public Playwright execution API. POST `/run` with JSON body:

```json
{ "code": "const { chromium } = require('playwright'); ..." }
```

Code may use either CommonJS (`require`) or ESM (`import`).

Response:

```json
{ "output": "stdout text", "exitCode": 0, "burned": true }
```

Helpers available in user code:
- `require('playwright')` — the real library
- `require('stealth')` — pre-configured stealth wrapper with Turnstile
  click + optional CAPTCHA solver. See `helpers/stealth/index.js`.

## Endpoints

| Method | Path        | Description                          |
|--------|-------------|--------------------------------------|
| GET    | `/`         | HTML landing page                    |
| GET    | `/api/info` | service info as JSON                 |
| GET    | `/health`   | liveness probe                       |
| POST   | `/run`      | execute Playwright code              |

## Deploy

### Hugging Face Space

Already configured. Push to the Space repo (`git@hf.co:spaces/<user>/<name>`)
and HF builds & runs the Dockerfile. The metadata at the top of this README
(`sdk: docker`, `app_port: 7860`) tells HF how to expose it.

### VPS / your own server

```sh
git clone https://github.com/cv3inx/playwright.git
cd playwright
cp .env.example .env
# edit .env if you want to change ports / resource caps / add solver keys
docker compose up -d --build
```

The compose file:
- builds the Dockerfile and runs the container
- exposes port `7860` on the host (override with `HOST_PORT` in `.env`)
- gives chromium 2 GB of shared memory (`shm_size: 2gb`)
- caps CPU and memory (defaults: 4 cores / 8 GB — tune in `.env`)
- runs `/health` as a Docker healthcheck
- mounts `/tmp` and `/app/runs` as tmpfs for fast per-request workspace I/O
- rotates logs (5 × 20 MB)

Test once it's up:
```sh
curl http://your-vps:7860/health
curl http://your-vps:7860/api/info | jq
```

For HTTPS, put nginx/caddy/traefik in front. With caddy, one line in the
Caddyfile:

```
playwright.example.com {
  reverse_proxy localhost:7860
}
```

## Hardening

Each request runs in an isolated process tree under a per-request workspace
(`/tmp/run-<id>`) with strict ulimits, stripped env, and `setpriv --no-new-privs`.
On completion (success, error, or timeout), the entire process group is
SIGKILL'd, the session is wiped (`pkill -s`), the workspace is `rm -rf`'d, and
orphaned chromium SHM segments are cleaned up — preventing any binary the
script wrote from persisting between requests.

Concurrent requests are isolated from each other: each gets its own pgid,
session, and workspace, so one request's burn cannot disrupt another in flight.

## Optional: CAPTCHA solver

If a target site shows the Cloudflare Turnstile checkbox but the auto-click
isn't enough (CF spawns an image challenge), `stealth.gotoBypass()` can fall
back to a paid solver service. Set one of:

- `TWOCAPTCHA_KEY` — https://2captcha.com
- `CAPSOLVER_KEY` — https://capsolver.com

On HF: Space settings → Variables and secrets.
On a VPS: edit `.env`.
