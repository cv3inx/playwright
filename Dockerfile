FROM mcr.microsoft.com/playwright:v1.49.0-jammy

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends util-linux procps psmisc ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user || true

ENV PORT=7860 \
    TIMEOUT_MS=1800000 \
    HOME=/home/user \
    BUN_INSTALL=/home/user/.bun \
    PATH=/home/user/.bun/bin:/usr/local/bin:/usr/bin:/bin \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
RUN mkdir -p /app/runs && chown -R user:user /app /home/user

USER user

RUN curl -fsSL https://bun.sh/install | bash

COPY --chown=user:user package.json ./
RUN bun install --production --ignore-scripts

COPY --chown=user:user server.js ./

EXPOSE 7860

CMD ["bun", "server.js"]
