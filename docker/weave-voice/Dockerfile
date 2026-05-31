# Multi-stage Dockerfile for Node.js Voice Chat App
# Optimized for Raspberry Pi 5 (arm64) and other arm64 platforms

# Stage 1: Build dependencies
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY app/package*.json ./

# Install dependencies
RUN npm install express ws dotenv

# Stage 2: Runtime
FROM node:18-alpine

# Install dumb-init to handle PID 1 correctly
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY app/server.js ./
COPY app/package.json ./
COPY app/public ./public

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S app -u 1001 && \
    chown -R app:nodejs /app

USER app

# Expose port (must match PORT in .env)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start server
CMD ["node", "server.js"]
