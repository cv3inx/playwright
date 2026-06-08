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

## Hardening

Each request runs in an isolated process tree under a per-request workspace
(`/tmp/run-<id>`) with strict ulimits, stripped env, and `setpriv --no-new-privs`.
On completion (success, error, or timeout), the entire process group is
SIGKILL'd, the session is wiped (`pkill -s`), the workspace is `rm -rf`'d, and
orphaned chromium SHM segments are cleaned up — preventing any binary the
script wrote from persisting between requests.

Concurrent requests are isolated from each other: each gets its own pgid,
session, and workspace, so one request's burn cannot disrupt another in flight.
