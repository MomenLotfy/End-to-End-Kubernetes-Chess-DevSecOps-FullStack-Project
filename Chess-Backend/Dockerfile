FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS production
# Wave 1: digest pinning is deferred until a Docker host can resolve + verify digests
# (registry API unreachable from here); see docs/security/wave1-baseline.md for commands.
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="chess-backend" \
      org.opencontainers.image.description="Chess backend: Express + Socket.io (single replica, ADR-002)" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/MomenLotfy/End-to-End-Kubernetes-Chess-DevSecOps-FullStack-Project"
# Secure default: compose sets NODE_ENV explicitly, so this only affects standalone runs,
# which then fail closed (HTTPS-only origins, mandatory SMTP/DB/JWT validation).
ENV NODE_ENV=production
RUN addgroup -S -g 1001 appgroup && adduser -S -D -H -u 1001 -G appgroup appuser
WORKDIR /app
COPY --from=dependencies --chown=1001:1001 /app/node_modules ./node_modules
COPY --chown=1001:1001 package.json package-lock.json ./
COPY --chown=1001:1001 src ./src
RUN mkdir -p /app/uploads/avatars && chown -R 1001:1001 /app/uploads && chmod 0750 /app/uploads /app/uploads/avatars
USER 1001:1001
EXPOSE 5000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:5000/liveness >/dev/null || exit 1
CMD ["node", "src/server.js"]
