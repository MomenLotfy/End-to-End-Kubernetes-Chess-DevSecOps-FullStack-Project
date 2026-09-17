const nodemailer = require("nodemailer");
const logger = require("../config/logger");

let transport;
function getTransport() {
  if (transport) return transport;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST) throw new Error("SMTP_HOST is required to deliver account emails");
  const port = Number(SMTP_PORT || 587);
  const requireTLS = process.env.SMTP_REQUIRE_TLS !== "false";
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465 && requireTLS,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
    tls: { rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false", minVersion: "TLSv1.2" },
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return transport;
}

async function verifyMailTransport() {
  await getTransport().verify();
}

async function sendAccountLink({ to, subject, path, text }) {
  const base = process.env.FRONTEND_URL;
  if (!base) throw new Error("FRONTEND_URL is required to construct account links");
  const url = new URL(path, `${base}/`).toString();
  await getTransport().sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text: `${text}\n\n${url}\n\nIf you did not request this, ignore this email.`,
  });
  // Never log recipient addresses or one-time links/tokens.
  logger.info("Account email accepted by SMTP", { messageType: subject });
}

module.exports = { sendAccountLink, verifyMailTransport };
