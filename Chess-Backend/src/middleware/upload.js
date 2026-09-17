const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads", "avatars");
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
});

function hasCompleteContainer(buffer) {
  if (buffer.length >= 12 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const end = offset + length + 12;
      if (end > buffer.length) return false;
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      offset = end;
      if (type === "IEND") return offset === buffer.length;
    }
    return false;
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  }
  if (buffer.length >= 14 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return buffer.at(-1) === 0x3b;
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return buffer.readUInt32LE(4) + 8 === buffer.length;
  }
  return false;
}

async function decodeAndNormalizeImage(buffer) {
  if (!hasCompleteContainer(buffer)) throw new Error("Malformed or trailing image content");
  // A real decoder then validates pixels, strips metadata and re-encodes the accepted raster.
  const image = sharp(buffer, {
    failOn: "warning",
    limitInputPixels: 25_000_000,
    animated: false,
  });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || metadata.pages > 1) throw new Error("Unsupported image");
  if (!["jpeg", "png", "gif", "webp"].includes(metadata.format)) throw new Error("Unsupported image format");
  if (metadata.width > 4096 || metadata.height > 4096) throw new Error("Image dimensions are too large");
  return image.rotate().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85, effort: 4 })
    .toBuffer();
}

async function inspectAndStoreAvatar(req, res, next) {
  if (!req.file?.buffer) return res.status(400).json({ error: "A valid image is required" });
  try {
    const normalized = await decodeAndNormalizeImage(req.file.buffer);
    await fs.mkdir(UPLOAD_DIR, { recursive: true, mode: 0o750 });
    const filename = `user${req.user.id}-${crypto.randomUUID()}.webp`;
    await fs.writeFile(path.join(UPLOAD_DIR, filename), normalized, { mode: 0o640, flag: "wx" });
    req.file.filename = filename;
    req.file.normalizedSize = normalized.length;
    next();
  } catch (error) {
    if (error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Avatar must not exceed 2 MB" });
    return res.status(400).json({ error: "A valid PNG, JPEG, GIF, or WebP image is required" });
  }
}

function uploadErrorHandler(error, req, res, next) {
  if (!(error instanceof multer.MulterError)) return next(error);
  if (error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Avatar must not exceed 2 MB" });
  return res.status(400).json({ error: "Invalid avatar upload" });
}

module.exports = {
  upload, inspectAndStoreAvatar, uploadErrorHandler, decodeAndNormalizeImage,
  hasCompleteContainer, UPLOAD_DIR, MAX_UPLOAD_BYTES,
};
