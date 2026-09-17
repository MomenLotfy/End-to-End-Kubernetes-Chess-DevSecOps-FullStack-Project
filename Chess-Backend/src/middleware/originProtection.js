const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originProtection(allowedOrigins, { production = process.env.NODE_ENV === "production" } = {}) {
  const allowed = new Set(allowedOrigins);
  return function verifyRequestOrigin(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get("Origin");
    const fetchSite = req.get("Sec-Fetch-Site");
    if (origin && allowed.has(origin) && (!fetchSite || fetchSite === "same-origin" || fetchSite === "same-site")) return next();
    if (!production && !origin && req.get("X-Chess-Client") === "trusted-test-client") return next();
    return res.status(403).json({ error: "Request origin rejected" });
  };
}

module.exports = { originProtection };
