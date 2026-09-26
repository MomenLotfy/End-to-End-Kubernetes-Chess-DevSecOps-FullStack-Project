// Wave 7 — avatar object storage abstraction.
//
// Two EXPLICIT modes, selected by AVATAR_STORAGE (default "local"):
//   local — filesystem under <repo>/uploads/avatars (pre-Wave-7 behavior).
//   s3    — private S3 bucket via IRSA pod identity. No static AWS credentials
//           are read by this process: auth comes from the SDK default chain
//           (web-identity token in EKS, env/shared config elsewhere).
//
// The public avatar_url shape NEVER changes (/uploads/avatars/<file>), so the
// DB, the frontend and the rollback path never see storage internals.
//
// Migration/compatibility contract (explicit, no silent split-brain):
//   - writes go to exactly ONE store (the configured mode) — never dual-write;
//   - in s3 mode, a read that misses S3 falls back to the local file ONLY when
//     AVATAR_S3_LEGACY_FALLBACK=true (migration window) and EVERY fallback is
//     counted (s3_legacy_fallback_reads_total) — a stuck fallback rate means
//     the backfill is incomplete, not silent success;
//   - deletes are best-effort per store and report ok/false to the caller;
//   - rollback = set AVATAR_STORAGE=local: pre-migration avatars keep working,
//     S3-only avatars 404 until re-migrated (documented in the runbook).
"use strict";

const fs = require("fs/promises");
const path = require("path");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const logger = require("../config/logger");
const { observeS3, observeLegacyFallback } = require("../metrics/s3");

const LOCAL_DIR = path.join(__dirname, "..", "..", "uploads", "avatars");
const KEY_PREFIX = "avatars/";
const CONTENT_TYPE = "image/webp";
// Strict managed-avatar shape: user<id>-<uuid>.webp (what the uploader mints).
const MANAGED_PATH_RE = /^\/uploads\/avatars\/(user\d+-[0-9a-f-]+\.webp)$/;
const MANAGED_FILE_RE = /^user\d+-[0-9a-f-]+\.webp$/;
const S3_OP_TIMEOUT_MS = 15000;

let s3ClientOverride = null;
function setS3ClientForTests(client) { s3ClientOverride = client; }

let s3ClientInstance = null;
function s3Client() {
  if (s3ClientOverride) return s3ClientOverride;
  if (!s3ClientInstance) {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (!region) throw new Error("FATAL: AWS_REGION is required when AVATAR_STORAGE=s3");
    // No credentials passed: IRSA web identity (EKS) or ambient chain.
    s3ClientInstance = new S3Client({ region });
  }
  return s3ClientInstance;
}

function storageMode(env = process.env) {
  const mode = (env.AVATAR_STORAGE || "local").toLowerCase();
  if (mode !== "local" && mode !== "s3") throw new Error(`FATAL: AVATAR_STORAGE must be local|s3 (got ${mode})`);
  return mode;
}

function bucketName(env = process.env) {
  const bucket = env.S3_AVATARS_BUCKET;
  if (!bucket) throw new Error("FATAL: S3_AVATARS_BUCKET is required when AVATAR_STORAGE=s3");
  return bucket;
}

function legacyFallbackEnabled(env = process.env) {
  return (env.AVATAR_S3_LEGACY_FALLBACK || "true").toLowerCase() !== "false";
}

// DB avatar_url -> managed filename, or null when the URL is not one we minted
// (external/legacy URLs are left alone by delete/cleanup paths).
function managedAvatarFilename(publicPath) {
  const match = MANAGED_PATH_RE.exec(publicPath || "");
  return match ? match[1] : null;
}

// Filename -> S3 key. Defense in depth: the strict charset rejects traversal
// even if a caller passes an unvalidated string.
function keyForFilename(filename) {
  if (!MANAGED_FILE_RE.test(filename || "")) throw new Error("Refusing unsafe avatar filename");
  return `${KEY_PREFIX}${filename}`;
}

async function withTimeout(promise, ms, what) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectBody(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function isMissing(error) {
  const code = error?.Code || error?.name || error?.code || "";
  return code === "NoSuchKey" || code === "NotFound" || code === "NoSuchBucket" || error?.$metadata?.httpStatusCode === 404;
}

async function writeLocal(filename, buffer) {
  await fs.mkdir(LOCAL_DIR, { recursive: true, mode: 0o750 });
  // "wx" keeps the pre-Wave-7 no-overwrite guarantee (uuid names never collide).
  await fs.writeFile(path.join(LOCAL_DIR, filename), buffer, { mode: 0o640, flag: "wx" });
}

async function readLocal(filename) {
  try {
    const body = await fs.readFile(path.join(LOCAL_DIR, filename));
    return { body, size: body.length, etag: null, legacy: true };
  } catch (error) {
    return error?.code === "ENOENT" ? null : Promise.reject(error);
  }
}

// Persist one normalized avatar. Returns { mode, filename }. Throws on failure
// (callers translate to 500); in s3 mode NOTHING is written locally.
async function writeAvatar({ filename, buffer }, env = process.env) {
  if (!MANAGED_FILE_RE.test(filename || "")) throw new Error("Refusing unsafe avatar filename");
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("Avatar buffer is empty");
  const mode = storageMode(env);
  if (mode === "local") {
    await writeLocal(filename, buffer);
    return { mode, filename };
  }
  const start = process.hrtime.bigint();
  try {
    await withTimeout(s3Client().send(new PutObjectCommand({
      Bucket: bucketName(env),
      Key: keyForFilename(filename),
      Body: buffer,
      ContentType: CONTENT_TYPE,
      ContentLength: buffer.length,
      // No ACL header: the bucket enforces BucketOwnerEnforced (private ACLs impossible).
    })), S3_OP_TIMEOUT_MS, "S3 PutObject");
    observeS3("put", "ok", Number(process.hrtime.bigint() - start) / 1e9);
    return { mode, filename };
  } catch (error) {
    observeS3("put", "error", Number(process.hrtime.bigint() - start) / 1e9);
    logger.error("S3 avatar write failed", { error: error.message });
    throw new Error("Unable to store avatar");
  }
}

// Read one avatar. Returns { body, size, etag, legacy } or null when the object
// does not exist in any allowed store (caller answers 404).
async function readAvatar(filename, env = process.env) {
  if (!MANAGED_FILE_RE.test(filename || "")) return null;
  const mode = storageMode(env);
  if (mode === "local") return readLocal(filename);
  const start = process.hrtime.bigint();
  try {
    const out = await withTimeout(s3Client().send(new GetObjectCommand({
      Bucket: bucketName(env),
      Key: keyForFilename(filename),
    })), S3_OP_TIMEOUT_MS, "S3 GetObject");
    const body = await collectBody(out.Body);
    observeS3("get", "ok", Number(process.hrtime.bigint() - start) / 1e9);
    return { body, size: body.length, etag: out.ETag || null, legacy: false };
  } catch (error) {
    if (!isMissing(error)) {
      observeS3("get", "error", Number(process.hrtime.bigint() - start) / 1e9);
      logger.error("S3 avatar read failed", { error: error.message });
      throw new Error("Unable to read avatar");
    }
    observeS3("get", "missing", Number(process.hrtime.bigint() - start) / 1e9);
    if (!legacyFallbackEnabled(env)) return null;
    const found = await readLocal(filename);
    if (found) {
      observeLegacyFallback();
      logger.warn("Avatar served from legacy local store (S3 object missing — backfill incomplete?)");
    }
    return found;
  }
}

// Best-effort delete. Returns true when the object is gone (or never existed),
// false when the delete itself failed (caller logs/alerts; orphan cleanup job
// reconciles — see the S3 runbook).
async function deleteAvatar(filename, env = process.env) {
  if (!MANAGED_FILE_RE.test(filename || "")) return true;
  const mode = storageMode(env);
  if (mode === "local") {
    try {
      await fs.unlink(path.join(LOCAL_DIR, filename));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      logger.warn("Local avatar cleanup failed", { error: error.message });
      return false;
    }
  }
  const start = process.hrtime.bigint();
  try {
    await withTimeout(s3Client().send(new DeleteObjectCommand({
      Bucket: bucketName(env),
      Key: keyForFilename(filename),
    })), S3_OP_TIMEOUT_MS, "S3 DeleteObject");
    observeS3("delete", "ok", Number(process.hrtime.bigint() - start) / 1e9);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      observeS3("delete", "missing", Number(process.hrtime.bigint() - start) / 1e9);
      return true;
    }
    observeS3("delete", "error", Number(process.hrtime.bigint() - start) / 1e9);
    logger.warn("S3 avatar delete failed (orphan — see runbook)", { error: error.message });
    return false;
  }
}

module.exports = {
  LOCAL_DIR, KEY_PREFIX, CONTENT_TYPE, S3_OP_TIMEOUT_MS,
  storageMode, bucketName, legacyFallbackEnabled,
  managedAvatarFilename, keyForFilename,
  writeAvatar, readAvatar, deleteAvatar,
  setS3ClientForTests,
};
