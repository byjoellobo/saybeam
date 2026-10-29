# Caption Room relay as a self-hosted server: one small image with the web app
# embedded in the binary. Build from the repository root:
#
#   docker build -t caption-room .
#   docker run -p 7300:7300 caption-room
#
# Offline speech models (optional): download them with
# `node scripts/fetch-models.mjs --out relay/models`, then mount the folder:
#
#   docker run -p 7300:7300 -v ./relay/models:/models:ro caption-room \
#     --bind 0.0.0.0 --port 7300 --models-dir /models
#
# See docs/self-hosting.md for HTTPS with Caddy and docker compose.

# ---- 1. Web app (apps/web/dist) ----
FROM node:24-bookworm-slim AS web
WORKDIR /src
# Manifests first so dependency installs are cached between source changes.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci --no-audit --no-fund
COPY . .
# Link shown in the app's footer. If you run a modified version for other
# people, point this at your source code (AGPL-3.0 section 13).
ARG CAPTION_ROOM_SOURCE_URL=https://github.com/mezpos/caption-room
ENV CAPTION_ROOM_SOURCE_URL=${CAPTION_ROOM_SOURCE_URL}
RUN npm run build

# ---- 2. Relay binary with the web app embedded ----
FROM rust:1-bookworm AS relay
WORKDIR /src
COPY relay relay
COPY --from=web /src/apps/web/dist apps/web/dist
RUN cargo build --release --locked --manifest-path relay/Cargo.toml \
 && cp relay/target/release/caption-room-relay /caption-room-relay

# ---- 3. Runtime: glibc, CA certificates, no shell, non-root ----
FROM gcr.io/distroless/cc-debian12:nonroot
LABEL org.opencontainers.image.title="Caption Room relay" \
      org.opencontainers.image.description="Live captions shared with a room code: self-hosted server" \
      org.opencontainers.image.source="https://github.com/mezpos/caption-room" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
COPY --from=relay /caption-room-relay /usr/local/bin/caption-room-relay
COPY LICENSE relay/THIRD_PARTY_LICENSES.md /usr/share/doc/caption-room/
USER nonroot
EXPOSE 7300
ENTRYPOINT ["/usr/local/bin/caption-room-relay"]
CMD ["--bind", "0.0.0.0", "--port", "7300"]
