# All-in-one Dockerfile: Playwright API + bundled turnstile-solver.
# This is what HF Space builds (single container).
# For VPS, prefer `docker compose up` which uses solver/Dockerfile +
# this same file but with multi-service split (see docker-compose.yml).

FROM mcr.microsoft.com/playwright:v1.49.0-jammy

USER root

# --- Step 1: essential packages ---
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       util-linux procps psmisc ca-certificates curl unzip wget gnupg \
       python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# --- Step 2: fonts (best-effort) ---
RUN apt-get update && \
    for pkg in fonts-liberation fonts-noto fonts-noto-color-emoji fonts-noto-cjk \
               fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg \
               fonts-dejavu-core; do \
      apt-get install -y --no-install-recommends "$pkg" || echo "skip: $pkg"; \
    done && \
    rm -rf /var/lib/apt/lists/*

# --- Step 3: Xvfb + GTK/X11 deps for Camoufox (used by the solver) ---
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
       xvfb x11-utils dbus-x11 dumb-init \
       libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 \
       libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
       libpango-1.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
       libcups2 libxkbcommon0 libgbm1 libglib2.0-0 libexpat1 \
    || echo "Xvfb/GTK stack partial — solver may degrade" && \
    rm -rf /var/lib/apt/lists/*

# --- Step 4: Google Chrome stable (best-effort) ---
RUN set -eux; \
    ( \
      wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg && \
      echo 'deb [signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/google-chrome.list && \
      apt-get update && \
      apt-get install -y --no-install-recommends google-chrome-stable \
    ) || echo "Google Chrome install failed — channel:'chrome' will be unavailable, chromium still works"; \
    rm -rf /var/lib/apt/lists/*

ENV PORT=7860 \
    SOLVER_PORT=9988 \
    TIMEOUT_MS=1800000 \
    HOME=/home/pwuser \
    BUN_INSTALL=/home/pwuser/.bun \
    PATH=/home/pwuser/.bun/bin:/usr/local/bin:/usr/bin:/bin \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_PATH=/app/node_modules:/app/helpers \
    TRANSFORMERS_CACHE=/app/.cache/transformers \
    TESSDATA_PREFIX=/app/tesseract-data \
    COOKIES_DIR=/app/cookies \
    CAMOUFOX_HEADLESS=virtual \
    PYTHONUNBUFFERED=1 \
    TURNSTILE_SOLVER_URL=http://127.0.0.1:9988

WORKDIR /app
RUN mkdir -p /app/runs /app/helpers /app/public /app/cookies \
             /app/.cache/transformers /app/tesseract-data \
             /app/solver /home/pwuser \
    && chown -R 1000:1000 /app /home/pwuser

# --- Solver: install Python deps as root (needs system site-packages access) ---
COPY --chown=1000:1000 solver/requirements.txt /app/solver/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages \
        -r /app/solver/requirements.txt \
    && python3 -m camoufox fetch \
    || echo "[warn] solver dep install partial — /solve may degrade"

USER 1000

# --- Bun for the Playwright API server ---
RUN curl -fsSL https://bun.sh/install | bash

COPY --chown=1000:1000 package.json ./
RUN bun install --production --ignore-scripts

# --- Pre-fetch CAPTCHA models so first request is fast ---
RUN bun -e 'try { \
  const { pipeline, env } = await import("@huggingface/transformers"); \
  env.cacheDir = "/app/.cache/transformers"; \
  console.log("[prefetch] whisper-tiny.en..."); \
  await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", { quantized: true }); \
  console.log("[prefetch] whisper done"); \
} catch (e) { console.warn("[prefetch] whisper skipped:", e.message); }' \
 || echo "whisper prefetch skipped"

RUN cd /app/tesseract-data && \
    (curl -fsSLO https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata \
     && echo "[prefetch] tesseract eng.traineddata done") \
    || echo "tesseract prefetch skipped"

# --- Application code ---
COPY --chown=1000:1000 helpers/ ./helpers/
COPY --chown=1000:1000 public/ ./public/
COPY --chown=1000:1000 solver/solver.py solver/service.py solver/entrypoint.sh ./solver/
COPY --chown=1000:1000 solver/web ./solver/web
COPY --chown=1000:1000 server.js ./
COPY --chown=1000:1000 supervisor.sh ./

USER root
RUN chmod +x /app/solver/entrypoint.sh /app/supervisor.sh \
    && chown -R 1000:1000 /app
USER 1000

# --- Sanity check ---
RUN test -f /app/server.js \
    && test -f /app/supervisor.sh \
    && test -f /app/solver/service.py \
    && test -f /app/public/index.html \
    && test -d /app/helpers/stealth \
    && test -d /app/helpers/captcha \
    && test -f /app/node_modules/playwright/package.json \
    && echo "build artifacts OK"

EXPOSE 7860

# Supervisor launches the solver in the background, then the API in the
# foreground. If either dies the whole container exits and HF/Docker
# restarts it.
CMD ["bash", "/app/supervisor.sh"]
