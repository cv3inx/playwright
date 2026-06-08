FROM mcr.microsoft.com/playwright:v1.49.0-jammy

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends util-linux procps psmisc ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The base image already has a user at UID 1000 (pwuser). Reuse it — HF Spaces
# requires the container to run as UID 1000.
ENV PORT=7860 \
    TIMEOUT_MS=1800000 \
    HOME=/home/pwuser \
    BUN_INSTALL=/home/pwuser/.bun \
    PATH=/home/pwuser/.bun/bin:/usr/local/bin:/usr/bin:/bin \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
RUN mkdir -p /app/runs /home/pwuser \
    && chown -R 1000:1000 /app /home/pwuser

USER 1000

RUN curl -fsSL https://bun.sh/install | bash

COPY --chown=1000:1000 package.json ./
RUN bun install --production --ignore-scripts

COPY --chown=1000:1000 server.js ./

EXPOSE 7860

CMD ["bun", "server.js"]
