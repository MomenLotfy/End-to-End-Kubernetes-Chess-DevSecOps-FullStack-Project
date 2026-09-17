FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS production
COPY --from=builder --chown=101:101 /app/build /usr/share/nginx/html
COPY --chown=101:101 nginx.conf /etc/nginx/conf.d/default.conf
USER 101:101
EXPOSE 8080 8443
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 CMD ["nginx", "-t"]
CMD ["nginx", "-g", "daemon off;"]
