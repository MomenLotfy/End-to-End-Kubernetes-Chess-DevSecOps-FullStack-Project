FROM node:22-alpine
RUN addgroup -S -g 1001 appgroup && adduser -S -D -H -u 1001 -G appgroup appuser
WORKDIR /app
COPY --chown=1001:1001 package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=1001:1001 . .
USER 1001:1001
CMD ["node", "run.js"]
