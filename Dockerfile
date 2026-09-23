FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun build --compile src/cli/chat-scrobbler.ts --outfile /out/chat-scrobbler

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --system --create-home --home-dir /home/scrobbler --shell /usr/sbin/nologin scrobbler \
  && mkdir -p /data \
  && chown -R scrobbler:scrobbler /data

COPY --from=builder /out/chat-scrobbler /usr/local/bin/chat-scrobbler

ENV BIND_HOST=0.0.0.0 \
  CANONICAL_DIR=/data/canonical/sessions \
  INDEX_PATH=/data/index/sessions.db \
  MCP_HTTP_PORT=4321 \
  BACKUP_TARGET=/data/backups

VOLUME ["/data"]
EXPOSE 4318 4321 4322

USER scrobbler
CMD ["chat-scrobbler", "serve"]
