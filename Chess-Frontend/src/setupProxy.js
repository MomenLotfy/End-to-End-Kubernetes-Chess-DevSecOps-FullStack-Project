// DEV-ONLY preview helper (used by `react-scripts start` only; ignored in
// production builds). Proxies same-origin API traffic to the backend so auth
// cookies (SameSite) keep working in the sandboxed preview. Safe to delete.
const { createProxyMiddleware } = require("http-proxy-middleware");

const BACKEND = process.env.PROXY_BACKEND || "http://127.0.0.1:5000";

module.exports = function (app) {
  app.use(
    "/api",
    createProxyMiddleware({ target: BACKEND, changeOrigin: true, logLevel: "warn" })
  );
  app.use(
    "/socket.io",
    createProxyMiddleware({ target: BACKEND, changeOrigin: true, ws: true, logLevel: "warn" })
  );
  app.use(
    "/uploads",
    createProxyMiddleware({ target: BACKEND, changeOrigin: true, logLevel: "warn" })
  );
};
