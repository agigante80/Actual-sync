# Docker Deployment Guide

This guide covers deploying Actual-sync using Docker and Docker Compose.

## Table of Contents

- [Quick Start](#quick-start)
- [Docker Image](#docker-image)
- [Docker Compose](#docker-compose)
- [Configuration](#configuration)
- [Volumes and Persistence](#volumes-and-persistence)
- [Health Checks](#health-checks)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)
- [Advanced Topics](#advanced-topics)

## Quick Start

### Prerequisites

- Docker 20.10+ installed
- Docker Compose 1.29+ (or Docker with Compose V2)
- Configuration file ready (`config/config.json`)

### Using Docker Compose (Recommended)

1. **Create your configuration**:
```bash
cp config/config.example.json config/config.json
# Edit config/config.json with your settings
```

2. **Start the service**:
```bash
docker-compose up -d
```

3. **Check health**:
```bash
curl http://localhost:3000/health
```

4. **View logs**:
```bash
docker-compose logs -f actual-sync
```

### Using Docker CLI

1. **Build the image**:
```bash
docker build -t actual-sync:latest .
```

2. **Run the container**:
```bash
docker run -d \
  --name actual-sync \
  --restart unless-stopped \
  -v $(pwd)/config/config.json:/app/config/config.json:ro \
  -v actual-sync-data:/app/data \
  -v actual-sync-logs:/app/logs \
  -p 3000:3000 \
  actual-sync:latest
```

## Docker Image

### Multi-Stage Build

The Dockerfile uses a multi-stage build for optimal image size:

**Stage 1: Builder**
- Installs all dependencies including devDependencies
- Runs tests to ensure build quality
- Based on `node:20-alpine`

**Stage 2: Production**
- Only includes production dependencies
- Copies built artifacts from builder
- Minimal runtime image (~150MB)

### Image Features

- **Base**: Alpine Linux (minimal footprint)
- **Node.js**: Version 20 LTS
- **Non-root user**: Runs as `actualuser` (UID 1001)
- **Init system**: Uses `tini` for proper signal handling
- **Health check**: Built-in HTTP health check
- **Security**: No unnecessary packages or tools

### Building the Image

**Standard build**:
```bash
docker build -t actual-sync:latest .
```

**Build with custom tag**:
```bash
docker build -t myregistry/actual-sync:v1.0.0 .
```

**Build without cache**:
```bash
docker build --no-cache -t actual-sync:latest .
```

**Build with BuildKit**:
```bash
DOCKER_BUILDKIT=1 docker build -t actual-sync:latest .
```

## Docker Compose

### Basic Configuration

The provided `docker-compose.yml` includes:
- Actual-sync service
- Volume mounts for config and data
- Health checks
- Resource limits
- Logging configuration

### Starting Services

**Start in background**:
```bash
docker-compose up -d
```

**Start with logs**:
```bash
docker-compose up
```

**Rebuild and start**:
```bash
docker-compose up -d --build
```

### Managing Services

**Stop services**:
```bash
docker-compose stop
```

**Restart services**:
```bash
docker-compose restart
```

**Remove services**:
```bash
docker-compose down
```

**Remove services and volumes**:
```bash
docker-compose down -v
```

### Viewing Logs

**All logs**:
```bash
docker-compose logs
```

**Follow logs**:
```bash
docker-compose logs -f
```

**Last 100 lines**:
```bash
docker-compose logs --tail=100
```

**Specific service**:
```bash
docker-compose logs -f actual-sync
```

### Scaling (Not Recommended)

Actual-sync is not designed for horizontal scaling due to:
- SQLite database (single writer)
- Scheduled jobs (would run multiple times)
- State management

If you need high availability, use container restart policies instead.

## Configuration

### Configuration File

Mount your configuration file as read-only:

```yaml
volumes:
  - ./config/config.json:/app/config/config.json:ro
```

### Environment Variables

While configuration is primarily file-based, you can set:

```yaml
environment:
  - TZ=Europe/Madrid          # Timezone for scheduling
  - NODE_ENV=production       # Node environment
```

### Secrets Management

**Docker Secrets (Swarm)**:
```yaml
secrets:
  - config_json

services:
  actual-sync:
    secrets:
      - config_json
```

**External Config**:
Mount from external volume or config management system:
```yaml
volumes:
  - type: bind
    source: /secure/path/config.json
    target: /app/config/config.json
    read_only: true
```

## Volumes and Persistence

### Required Volumes

**Configuration** (read-only):
```yaml
- ./config/config.json:/app/config/config.json:ro
```

**Data directory** (sync history database):
```yaml
- actual-sync-data:/app/data
```

**Logs directory** (optional):
```yaml
- actual-sync-logs:/app/logs
```

### Budget File Directories

If your configuration references local paths for budget files:

```yaml
volumes:
  - ./budget-data:/budget-data
```

Update `config.json` accordingly:
```json
{
  "servers": [
    {
      "dataDir": "/budget-data/server1"
    }
  ]
}
```

### Volume Management

**List volumes**:
```bash
docker volume ls
```

**Inspect volume**:
```bash
docker volume inspect actual-sync-data
```

**Backup volume**:
```bash
docker run --rm \
  -v actual-sync-data:/data \
  -v $(pwd)/backup:/backup \
  alpine tar czf /backup/data-backup.tar.gz -C /data .
```

**Restore volume**:
```bash
docker run --rm \
  -v actual-sync-data:/data \
  -v $(pwd)/backup:/backup \
  alpine tar xzf /backup/data-backup.tar.gz -C /data
```

## Health Checks

### Built-in Health Check

The Dockerfile includes a health check:

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "..."
```

### Check Health Status

**Docker CLI**:
```bash
docker inspect --format='{{.State.Health.Status}}' actual-sync
```

**Docker Compose**:
```bash
docker-compose ps
```

### Health Endpoints

**Basic health**:
```bash
curl http://localhost:3000/health
```

**Detailed metrics**:
```bash
curl http://localhost:3000/metrics
```

**Readiness probe**:
```bash
curl http://localhost:3000/ready
```

### Kubernetes Health Probes

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 40
  periodSeconds: 30
  timeoutSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```

## Monitoring

### Container Stats

**Real-time stats**:
```bash
docker stats actual-sync
```

**Docker Compose stats**:
```bash
docker-compose stats
```

### Resource Limits

Configure in `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      cpus: '1.0'
      memory: 512M
    reservations:
      cpus: '0.25'
      memory: 128M
```

### Logging

**JSON file logging** (default):
```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

**Syslog logging**:
```yaml
logging:
  driver: syslog
  options:
    syslog-address: "tcp://192.168.1.100:514"
    tag: "actual-sync"
```

**GELF logging** (for Graylog):
```yaml
logging:
  driver: gelf
  options:
    gelf-address: "udp://192.168.1.100:12201"
    tag: "actual-sync"
```

### Prometheus Integration

See the commented-out Prometheus service in `docker-compose.yml`:

```yaml
prometheus:
  image: prom/prometheus:latest
  ports:
    - "9090:9090"
  volumes:
    - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
```

## Troubleshooting

### Container Won't Start

**Check logs**:
```bash
docker-compose logs actual-sync
```

**Common issues**:
- Missing or invalid `config.json`
- Port 3000 already in use
- Volume permission issues

**Solution**:
```bash
# Check config syntax
docker run --rm -v $(pwd)/config:/config node:20-alpine \
  node -e "JSON.parse(require('fs').readFileSync('/config/config.json'))"

# Check port
netstat -tulpn | grep 3000

# Fix permissions
sudo chown -R 1001:1001 ./data ./logs
```

### Health Check Failing

**Check endpoint**:
```bash
curl -v http://localhost:3000/health
```

**Inspect container**:
```bash
docker exec -it actual-sync sh
```

**Check inside container**:
```bash
# Inside container
wget -O- http://localhost:3000/health
cat /app/logs/*.log
```

### High Memory Usage

**Check stats**:
```bash
docker stats actual-sync --no-stream
```

**Solutions**:
- Reduce `retentionDays` in sync history
- Increase memory limit
- Check for memory leaks in logs

### Permission Errors

**Issue**: Cannot write to volumes

**Solution**:
```bash
# Create directories with correct ownership
mkdir -p data logs
sudo chown -R 1001:1001 data logs

# Or run as root (not recommended)
docker-compose.yml:
  user: "0:0"
```

### Network Issues

**Can't reach Actual Budget server**:
```bash
# Test from container
docker exec actual-sync ping actual-server

# Check network
docker network inspect actual-network

# Use host network (temporary debugging)
docker run --network host actual-sync:latest
```

## Advanced Topics

### Multi-Architecture Builds

Build for multiple platforms:

```bash
docker buildx create --use
docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t myregistry/actual-sync:latest \
  --push .
```

### Custom Dockerfile

Create `Dockerfile.custom`:

```dockerfile
FROM actual-sync:latest

# Add custom tools
RUN apk add --no-cache curl vim

# Custom entrypoint
COPY custom-entrypoint.sh /
ENTRYPOINT ["/custom-entrypoint.sh"]
```

### Docker Swarm Deployment

Create `docker-stack.yml`:

```yaml
version: '3.8'
services:
  actual-sync:
    image: actual-sync:latest
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
    configs:
      - source: actual-sync-config
        target: /app/config/config.json
    volumes:
      - actual-sync-data:/app/data

configs:
  actual-sync-config:
    external: true

volumes:
  actual-sync-data:
    driver: local
```

Deploy:
```bash
docker stack deploy -c docker-stack.yml actual-sync
```

### Kubernetes Deployment

Create `k8s-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: actual-sync
spec:
  replicas: 1
  selector:
    matchLabels:
      app: actual-sync
  template:
    metadata:
      labels:
        app: actual-sync
    spec:
      containers:
      - name: actual-sync
        image: actual-sync:latest
        ports:
        - containerPort: 3000
          name: health
        volumeMounts:
        - name: config
          mountPath: /app/config
          readOnly: true
        - name: data
          mountPath: /app/data
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 40
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 10
      volumes:
      - name: config
        configMap:
          name: actual-sync-config
      - name: data
        persistentVolumeClaim:
          claimName: actual-sync-data
---
apiVersion: v1
kind: Service
metadata:
  name: actual-sync
spec:
  selector:
    app: actual-sync
  ports:
  - port: 3000
    targetPort: 3000
    name: health
```

### CI/CD Integration

**GitHub Actions** (`.github/workflows/docker.yml`):

```yaml
name: Docker Build

on:
  push:
    branches: [ main ]
    tags: [ 'v*' ]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2
      
      - name: Login to DockerHub
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
      
      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: .
          push: true
          tags: |
            myregistry/actual-sync:latest
            myregistry/actual-sync:${{ github.sha }}
```

## Best Practices

1. **Always use volumes** for data and config persistence
2. **Use read-only mounts** for configuration files
3. **Set resource limits** to prevent resource exhaustion
4. **Configure log rotation** to prevent disk fill
5. **Use health checks** for automatic restarts
6. **Run as non-root** (default in our Dockerfile)
7. **Keep images updated** with security patches
8. **Use specific tags** instead of `latest` in production
9. **Monitor container metrics** regularly
10. **Backup volumes** before updates

## Security Considerations

1. **Non-root user**: Container runs as UID 1001
2. **Read-only config**: Configuration mounted as read-only
3. **No privileged mode**: Container doesn't require elevated privileges
4. **Minimal base image**: Alpine Linux reduces attack surface
5. **No secrets in logs**: Sensitive data not logged
6. **Network isolation**: Use Docker networks for service communication
7. **Regular updates**: Keep base images and dependencies updated

## Performance Tuning

**Node.js memory limit**:
```yaml
environment:
  - NODE_OPTIONS=--max-old-space-size=384
```

**Adjust resource limits**:
```yaml
deploy:
  resources:
    limits:
      cpus: '2.0'
      memory: 1G
```

**Use bind mounts for development** (faster than volumes on Mac/Windows):
```yaml
volumes:
  - type: bind
    source: ./config
    target: /app/config
```

## Summary

Docker deployment provides:

✅ **Consistent environment** across all platforms
✅ **Easy deployment** with single command
✅ **Isolation** from host system
✅ **Resource management** with limits
✅ **Health monitoring** built-in
✅ **Volume persistence** for data
✅ **Production-ready** with security best practices

For most users, `docker-compose up -d` is all you need to get started!
