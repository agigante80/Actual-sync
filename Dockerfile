# Multi-stage Dockerfile for Actual-sync
# Optimized for minimal image size and production deployment

# Stage 1: Builder
# Use native platform for building to avoid QEMU emulation issues
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Run tests to ensure build quality
RUN npm test

# Stage 2: Production image
FROM node:20-alpine

# Build arguments for dynamic versioning
ARG VERSION=unknown
ENV VERSION=${VERSION}

# Install runtime dependencies and tini
RUN apk add --no-cache sqlite tini

# Create non-root user
RUN addgroup -g 1001 -S actualuser && \
    adduser -u 1001 -S actualuser -G actualuser

WORKDIR /app

# Copy package files and node_modules from builder
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy application files from builder
COPY --from=builder /app/src ./src
COPY --from=builder /app/config ./config
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/index.js ./

# Create directories with proper permissions
RUN mkdir -p /app/data /app/logs && \
    chown -R actualuser:actualuser /app

# OCI metadata labels
LABEL org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.title="actual-sync" \
      org.opencontainers.image.description="Automated bank synchronization service for Actual Budget with multi-server support" \
      org.opencontainers.image.vendor="Actual-sync" \
      org.opencontainers.image.licenses="MIT"

# Switch to non-root user
USER actualuser

# Expose health check port
EXPOSE 3000

# Health check using the built-in endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start the application
CMD ["node", "index.js"]
