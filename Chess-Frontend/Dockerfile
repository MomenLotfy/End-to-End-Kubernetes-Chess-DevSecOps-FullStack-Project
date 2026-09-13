# ============================================================
# Dockerfile — Tetris V2 (محدّث بالكامل)
# Multi-Stage Build: Node 22 LTS → nginx:alpine
# ============================================================

FROM node:22-alpine AS builder

LABEL maintainer="DevSecOps Team"
LABEL stage="builder"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

# ── الإنتاج ───────────────────────────────────────────────
FROM nginx:1.27-alpine AS production

LABEL maintainer="DevSecOps Team"
LABEL app="tetris-v2"

COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost/ || exit 1

RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chmod -R 755 /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
