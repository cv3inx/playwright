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

## Endpoints

| Method | Path        | Description                          |
|--------|-------------|--------------------------------------|
| GET    | `/`         | HTML landing page                    |
| GET    | `/api/info` | service info as JSON                 |
| GET    | `/health`   | liveness probe                       |
| POST   | `/run`      | execute Playwright code              |

## Helpers in user code

```js
const playwright = require('playwright');
const stealth    = require('stealth');   // anti-bot launch wrapper
const captcha    = require('captcha');   // local CAPTCHA solvers + solver client
```

The bundled CAPTCHA suite — no third-party APIs, no per-solve fees:

- **Turnstile / "Just a moment"** — `captcha.solveTurnstile(page)` and
  `captcha.clearChallenge(siteurl)` use the bundled solver service
  (Camoufox, runs in the same container).
- **reCAPTCHA v2** — `captcha.solveRecaptchaV2(page)` does the audio
  fallback flow with local Whisper.
- **Text/image CAPTCHA** — `captcha.ocrBuffer(buf)` via local Tesseract.
- **Math CAPTCHA** — `captcha.solveMath('2 + 3 * 4')`.
- **Cookie jar** — `captcha.saveCookies / loadCookies` to skip re-solving
  challenges on subsequent requests.

## Deploy

### Hugging Face Space

Push to `git@hf.co:spaces/<user>/<name>`. The Dockerfile bundles both the
Playwright API and the Turnstile solver in a single image (HF only allocates
one container per Space). A supervisor script starts the solver in the
background and the API in the foreground.

### VPS / your own server

```sh
git clone https://github.com/cv3inx/playwright.git
cd playwright
cp .env.example .env
docker compose up -d --build
```

Compose runs two containers on an internal Docker network:
- `playwright-api` (port 7860 → host) — the API
- `turnstile-solver` (port 9988, internal only) — the solver

Wired automatically — `playwright-api` calls `http://turnstile-solver:9988`
inside the network. No external URLs, no API keys.

For HTTPS, put nginx/caddy/traefik in front of port 7860.

## Hardening

Each request runs in an isolated process tree under a per-request workspace
(`/tmp/run-<id>`) with strict ulimits, stripped env, and `setpriv --no-new-privs`.
On completion (success, error, or timeout), the entire process group is
SIGKILL'd, the session is wiped (`pkill -s`), the workspace is `rm -rf`'d, and
orphaned chromium SHM segments are cleaned up — preventing any binary the
script wrote from persisting between requests.

Concurrent requests are isolated from each other: each gets its own pgid,
session, and workspace, so one request's burn cannot disrupt another in flight.
