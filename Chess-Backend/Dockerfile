FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS production
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
