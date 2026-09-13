// ============================================================
// middleware/upload.js — رفع صور الأفاتار (Avatar Upload)
// ============================================================
const multer = require("multer");
const path   = require("path");
const fs     = require("fs");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads", "avatars");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `user${req.user.id}-${Date.now()}${ext}`);
  },
});

const ALLOWED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED.has(ext)) return cb(new Error("Only image files are allowed (png, jpg, jpeg, gif, webp)"));
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

module.exports = { upload, UPLOAD_DIR };
