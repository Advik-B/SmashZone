# ---- Stage 1: build the WASM sim + client bundle ----
FROM rust:1.85-slim AS wasm-builder
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/* \
    && rustup target add wasm32-unknown-unknown \
    && curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
WORKDIR /app
COPY Cargo.toml ./
COPY crates ./crates
COPY shared ./shared
RUN wasm-pack build crates/sim-wasm --target web \
    --out-dir /app/client/src/wasm/pkg --release

FROM oven/bun:1-slim AS client-builder
WORKDIR /app
COPY client/package.json client/bun.lock ./client/
RUN cd client && bun install --frozen-lockfile
COPY client ./client
COPY shared ./shared
COPY --from=wasm-builder /app/client/src/wasm/pkg ./client/src/wasm/pkg
# Stamped into replay files: postcard wire bytes are only guaranteed decodable
# by the build that wrote them, so the viewer warns on mismatched replays.
# Pass e.g. --build-arg BUILD_ID=$(git rev-parse --short HEAD) when deploying.
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID
RUN cd client && bun run build

# ---- Stage 2: build the game server (embeds client/dist via build.rs) ----
FROM rust:1.85-slim AS server-builder
WORKDIR /app
COPY Cargo.toml ./
COPY crates ./crates
COPY shared ./shared
COPY --from=client-builder /app/client/dist ./client/dist
RUN cargo build --release -p gameserver

# ---- Stage 3: minimal runtime — the binary is the whole deployment ----
FROM debian:bookworm-slim
WORKDIR /app
COPY --from=server-builder /app/target/release/gameserver ./gameserver
ENV RUST_LOG=info
# Listens on $PORT (Render-style PaaS) or BIND_ADDR; defaults to 0.0.0.0:8080.
EXPOSE 8080
CMD ["./gameserver"]
