# Multi-stage Dockerfile for Weave (mediasoup SFU)
# Optimised for Raspberry Pi 5 (arm64/aarch64)

# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

# mediasoup native module needs a C++ toolchain and kernel headers
RUN apk add --no-cache python3 py3-pip make g++ linux-headers

# Install all dependencies (mediasoup server + mediasoup-client browser lib)
COPY app/package*.json ./
RUN npm install

# Bundle mediasoup-client into a single browser-ready file (window.mediasoupClient)
RUN npx esbuild node_modules/mediasoup-client/lib/index.js \
    --bundle --format=iife --global-name=mediasoupClient \
    --platform=browser --minify \
    --outfile=/tmp/mediasoup-client.min.js

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:18-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

# Compiled node_modules (includes mediasoup-worker binary)
COPY --from=builder /app/node_modules ./node_modules

# Application files
COPY app/server.js ./
COPY app/db.js ./
COPY app/package.json ./
COPY app/public ./public

# Inject the browser-bundled mediasoup-client into public/
COPY --from=builder /tmp/mediasoup-client.min.js ./public/mediasoup-client.min.js

# Non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S app -u 1001 && \
    chown -R app:nodejs /app && \
    mkdir -p /app/logs && chown app:nodejs /app/logs && \
    mkdir -p /app/data && chown app:nodejs /app/data

USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000',(r)=>{process.exit(r.statusCode===200?0:1)})"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server.js"]
