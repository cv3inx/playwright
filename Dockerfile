FROM mcr.microsoft.com/playwright:v1.49.0-jammy

USER root

# Hardening tools, comprehensive fonts, Xvfb (for headed-mode bypasses),
# Google Chrome stable (for Widevine DRM + real-Chrome fingerprint).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       util-linux procps psmisc ca-certificates curl unzip wget gnupg \
       xvfb x11-utils dbus-x11 \
       fonts-liberation fonts-noto fonts-noto-color-emoji fonts-noto-cjk \
       fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo 'deb [signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# HF Spaces convention: UID 1000 user (pwuser already exists in base image)
ENV PORT=7860 \
    TIMEOUT_MS=1800000 \
    HOME=/home/pwuser \
    BUN_INSTALL=/home/pwuser/.bun \
    PATH=/home/pwuser/.bun/bin:/usr/local/bin:/usr/bin:/bin \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_PATH=/app/node_modules:/app/helpers

WORKDIR /app
RUN mkdir -p /app/runs /app/helpers /home/pwuser \
    && chown -R 1000:1000 /app /home/pwuser

USER 1000

RUN curl -fsSL https://bun.sh/install | bash

COPY --chown=1000:1000 package.json ./
RUN bun install --production --ignore-scripts

COPY --chown=1000:1000 helpers/ ./helpers/
COPY --chown=1000:1000 server.js ./

EXPOSE 7860

CMD ["bun", "server.js"]
