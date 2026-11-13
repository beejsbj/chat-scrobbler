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

# Asset blobs are written 0600 by this user, and the embedder sidecar reads them
# as the same uid:gid. Compose passes one DATA_UID/DATA_GID to both images so
# they cannot drift. Existing data volumes are owned by 999, so keep that default.
ARG DATA_UID=999
ARG DATA_GID=999
RUN groupadd --system --gid "${DATA_GID}" scrobbler \
  && useradd --system --uid "${DATA_UID}" --gid "${DATA_GID}" --create-home --home-dir /home/scrobbler --shell /usr/sbin/nologin scrobbler \
  && mkdir -p /data \
  && chown -R scrobbler:scrobbler /data

COPY --from=builder /out/chat-scrobbler /usr/local/bin/chat-scrobbler

ENV BIND_HOST=0.0.0.0 \
  CANONICAL_DIR=/data/canonical/sessions \
  INDEX_PATH=/data/index/sessions.db \
  MCP_HTTP_PORT=4321 \
  BACKUP_TARGET=/data/backups

VOLUME ["/data"]
EXPOSE 4318 4321

USER scrobbler
CMD ["chat-scrobbler", "serve"]
