# --- web app ---------------------------------------------------------------
FROM oven/bun:1 AS web
WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

# --- server ----------------------------------------------------------------
FROM rust:1-slim-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY server ./server
# Workspace member manifest only (the desktop app is not built here).
COPY web/src-tauri/Cargo.toml web/src-tauri/build.rs ./web/src-tauri/
COPY web/src-tauri/src ./web/src-tauri/src
RUN cargo build --release --locked -p e2ee-chat-server

# --- runtime ---------------------------------------------------------------
FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home /data chat && mkdir -p /data && chown chat /data
COPY --from=server /src/target/release/e2ee-chat-server /usr/local/bin/e2ee-chat-server
COPY --from=web /src/web/dist /app/web
ENV PORT=8080 DATA_DIR=/data WEB_DIR=/app/web
USER chat
VOLUME /data
EXPOSE 8080
CMD ["e2ee-chat-server"]
