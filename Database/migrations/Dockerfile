FROM node:22-alpine
# Wave 1: digest pinning deferred (see backend Dockerfile note + wave1 baseline doc).
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="chess-migration" \
      org.opencontainers.image.description="Chess one-shot ordered migration runner (advisory lock + checksums)" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/MomenLotfy/End-to-End-Kubernetes-Chess-DevSecOps-FullStack-Project"
RUN addgroup -S -g 1001 appgroup && adduser -S -D -H -u 1001 -G appgroup appuser
WORKDIR /app
COPY --chown=1001:1001 package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=1001:1001 . .
USER 1001:1001
CMD ["node", "run.js"]
