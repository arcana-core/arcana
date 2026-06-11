# Arcana gateway — agent PaaS server.
FROM node:22-slim

# ffmpeg/git are commonly needed by services and agent tools; drop if unused.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source.
COPY . .

# Persistent state (sessions, vault, tokens) lives here — mount a volume.
ENV ARCANA_HOME=/data/.arcana
VOLUME ["/data"]

# Bind on all interfaces inside the container; require auth even though a
# proxy may forward to loopback. Isolate services into child processes.
ENV ARCANA_BIND_HOST=0.0.0.0 \
    ARCANA_REQUIRE_AUTH=1 \
    ARCANA_SERVICE_ISOLATION=process \
    PORT=8787

EXPOSE 8787

# tini for correct signal handling -> the gateway's graceful shutdown hooks.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "bin/arcana.js", "gateway", "serve"]
