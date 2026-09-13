# ============================================================
# Dockerfile — Chess Backend
# Multi-Stage Build: node:22-alpine
# ============================================================

FROM node:22-alpine AS builder

LABEL maintainer="DevSecOps Team"
LABEL stage="builder"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# ── Production Stage ──────────────────────────────────────
FROM node:22-alpine AS production

LABEL maintainer="DevSecOps Team"
LABEL app="chess-backend"

# مستخدم غير root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src          ./src
COPY package*.json ./

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:5000/health || exit 1

CMD ["node", "src/server.js"]
