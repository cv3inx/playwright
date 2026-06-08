FROM mcr.microsoft.com/playwright:v1.49.0-jammy

USER root

# Step 1 — essential packages. If this fails, build should fail (we need these).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       util-linux procps psmisc ca-certificates curl unzip wget gnupg \
    && rm -rf /var/lib/apt/lists/*

# Step 2 — fonts (best-effort: some packages may be missing on certain mirrors).
# Allow individual font packages to fail without killing the build.
RUN apt-get update && \
    for pkg in fonts-liberation fonts-noto fonts-noto-color-emoji fonts-noto-cjk \
               fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg; do \
      apt-get install -y --no-install-recommends "$pkg" || echo "skip: $pkg"; \
    done && \
    rm -rf /var/lib/apt/lists/*

# Step 3 — Xvfb for headed-mode bypass (best-effort).
RUN apt-get update && \
    apt-get install -y --no-install-recommends xvfb x11-utils dbus-x11 \
    || echo "Xvfb stack failed — headed mode unavailable" && \
    rm -rf /var/lib/apt/lists/*

# Step 4 — Google Chrome stable (best-effort: Widevine DRM optional).
# If Google's repo or signing key is unavailable, continue with chromium only.
RUN set -eux; \
    ( \
      wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg && \
      echo 'deb [signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/google-chrome.list && \
      apt-get update && \
      apt-get install -y --no-install-recommends google-chrome-stable \
    ) || echo "Google Chrome install failed — channel:'chrome' will be unavailable, chromium still works"; \
    rm -rf /var/lib/apt/lists/*

ENV PORT=7860 \
    TIMEOUT_MS=1800000 \
    HOME=/home/pwuser \
    BUN_INSTALL=/home/pwuser/.bun \
    PATH=/home/pwuser/.bun/bin:/usr/local/bin:/usr/bin:/bin \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_PATH=/app/node_modules:/app/helpers

WORKDIR /app
RUN mkdir -p /app/runs /app/helpers /app/public /home/pwuser \
    && chown -R 1000:1000 /app /home/pwuser

USER 1000

# Bun install — fail loud if this breaks
RUN curl -fsSL https://bun.sh/install | bash

COPY --chown=1000:1000 package.json ./
RUN bun install --production --ignore-scripts

COPY --chown=1000:1000 helpers/ ./helpers/
COPY --chown=1000:1000 public/ ./public/
COPY --chown=1000:1000 server.js ./

# Sanity: confirm the artifacts the server expects to find at runtime
RUN test -f /app/server.js \
    && test -f /app/public/index.html \
    && test -d /app/helpers/stealth \
    && test -f /app/node_modules/playwright/package.json \
    && echo "build artifacts OK"

EXPOSE 7860

CMD ["bun", "server.js"]
