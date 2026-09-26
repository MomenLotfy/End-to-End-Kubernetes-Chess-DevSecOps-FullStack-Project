FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS production
# Wave 1: digest pinning deferred (see backend Dockerfile note + wave1 baseline doc).
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="chess-frontend" \
      org.opencontainers.image.description="Chess frontend: React static build + unprivileged Nginx TLS proxy" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/MomenLotfy/End-to-End-Kubernetes-Chess-DevSecOps-FullStack-Project"
COPY --from=builder --chown=101:101 /app/build /usr/share/nginx/html
COPY --chown=101:101 nginx.conf /etc/nginx/conf.d/default.conf
USER 101:101
EXPOSE 8080 8443
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 CMD ["nginx", "-t"]
CMD ["nginx", "-g", "daemon off;"]
