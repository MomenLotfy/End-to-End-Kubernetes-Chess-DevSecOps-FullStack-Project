// Structured JSON logging (Wave 6 §9/§10). Production/test emit single-line
// JSON to stdout (Alloy -> Loki); development keeps human-readable output.
// EVERYTHING passes through redaction BEFORE serialization, so a forgotten
// sensitive field is scrubbed rather than shipped.
const winston = require("winston");
const { redact } = require("./logSanitize");

const redactionFormat = winston.format(info => redact(info));

function buildLogger(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const pretty = nodeEnv !== "production" && nodeEnv !== "test";
  return winston.createLogger({
    level: env.LOG_LEVEL || "info",
    defaultMeta: {
      service: "chess-backend",
      environment: nodeEnv,
    },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      redactionFormat(),
      pretty
        ? winston.format.combine(winston.format.colorize(), winston.format.simple())
        : winston.format.json()
    ),
    transports: [new winston.transports.Console({ stderrLevels: ["error"] })],
  });
}

module.exports = buildLogger();
module.exports.buildLogger = buildLogger;
