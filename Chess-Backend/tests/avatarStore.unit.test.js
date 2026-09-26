// Wave 7 — avatarStore unit tests. S3 is NEVER touched: a fake client records
// commands. Local-mode tests use user999999-* marker files and always delete
// them (uploads/ is not gitignored — nothing may be left behind).
"use strict";

process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
process.env.NODE_ENV = "test";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const store = require("../src/services/avatarStore");
const metrics = require("../src/metrics");

const S3_ENV = { AVATAR_STORAGE: "s3", S3_AVATARS_BUCKET: "test-avatars", AWS_REGION: "us-east-1" };
const LOCAL_ENV = { AVATAR_STORAGE: "local" };
const markerFile = () => `user999999-${crypto.randomUUID()}.webp`;

afterEach(() => store.setS3ClientForTests(null));
afterAll(async () => {
  const dir = store.LOCAL_DIR;
  const entries = await fs.readdir(dir).catch(() => []);
  await Promise.all(entries.filter(n => n.startsWith("user999999-")).map(n => fs.unlink(path.join(dir, n)).catch(() => {})));
});

function fakeS3(behavior) {
  const calls = [];
  const client = {
    calls,
    async send(command) {
      calls.push(command);
      return behavior(command, calls.length);
    },
  };
  store.setS3ClientForTests(client);
  return client;
}

const metricVal = (name, labels = "") => {
  const m = metrics.renderMetrics().match(new RegExp(`^${name}${labels} ([0-9.eE+-]+)$`, "m"));
  return m ? Number(m[1]) : 0;
};

test("managedAvatarFilename accepts only minted URLs", () => {
  const good = "/uploads/avatars/user7-989b7f55-9a4a-4721-b81e-ec644dbdcaa8.webp";
  expect(store.managedAvatarFilename(good)).toBe("user7-989b7f55-9a4a-4721-b81e-ec644dbdcaa8.webp");
  for (const bad of [
    "https://evil.example/x.webp",
    "/uploads/avatars/../../../../etc/passwd",
    "/uploads/avatars/user7-x.png",
    "/uploads/avatars/user7-x.WEBP",
    "/uploads/avatars/user-abc.webp",
    "/uploads/other/user7-x.webp",
    "",
    null,
    undefined,
  ]) {
    expect(store.managedAvatarFilename(bad)).toBeNull();
  }
});

test("keyForFilename maps to the avatars/ prefix and rejects traversal", () => {
  expect(store.keyForFilename("user7-abc.webp")).toBe("avatars/user7-abc.webp");
  for (const bad of ["../x.webp", "a/b.webp", "..\\x.webp", "/abs.webp", "user7-x.png", "", null]) {
    expect(() => store.keyForFilename(bad)).toThrow("Refusing unsafe avatar filename");
  }
});

test("storageMode defaults to local and rejects unknown modes loudly", () => {
  expect(store.storageMode({})).toBe("local");
  expect(store.storageMode({ AVATAR_STORAGE: "S3" })).toBe("s3");
  expect(() => store.storageMode({ AVATAR_STORAGE: "gcs" })).toThrow("FATAL");
  expect(() => store.bucketName({})).toThrow("FATAL");
});

test("local mode roundtrip: write -> read -> delete -> missing", async () => {
  const filename = markerFile();
  const body = Buffer.from("fake-webp-bytes");
  const written = await store.writeAvatar({ filename, buffer: body }, LOCAL_ENV);
  expect(written).toEqual({ mode: "local", filename });
  const found = await store.readAvatar(filename, LOCAL_ENV);
  expect(found.body.equals(body)).toBe(true);
  expect(found.legacy).toBe(true);
  expect(await store.deleteAvatar(filename, LOCAL_ENV)).toBe(true);
  expect(await store.readAvatar(filename, LOCAL_ENV)).toBeNull();
  // Deleting twice is still success (idempotent cleanup path).
  expect(await store.deleteAvatar(filename, LOCAL_ENV)).toBe(true);
});

test("local write refuses to overwrite (wx semantics preserved)", async () => {
  const filename = markerFile();
  await store.writeAvatar({ filename, buffer: Buffer.from("one") }, LOCAL_ENV);
  await expect(store.writeAvatar({ filename, buffer: Buffer.from("two") }, LOCAL_ENV)).rejects.toThrow();
  await store.deleteAvatar(filename, LOCAL_ENV);
});

test("s3 write sends a private PutObject (no ACL, webp, key prefix)", async () => {
  const client = fakeS3(async () => ({}));
  const filename = "user7-abc-def.webp";
  await store.writeAvatar({ filename, buffer: Buffer.from("img") }, S3_ENV);
  expect(client.calls).toHaveLength(1);
  const input = client.calls[0].input;
  expect(client.calls[0].constructor.name).toBe("PutObjectCommand");
  expect(input.Bucket).toBe("test-avatars");
  expect(input.Key).toBe("avatars/user7-abc-def.webp");
  expect(input.ContentType).toBe("image/webp");
  expect(input.ACL).toBeUndefined();
  expect(input.GrantRead).toBeUndefined();
});

test("s3 write failure throws (no silent local fallback) and counts error", async () => {
  fakeS3(async () => { throw new Error("boom"); });
  const before = metricVal("s3_operations_total", '{operation="put",result="error"}');
  await expect(store.writeAvatar({ filename: "user7-a.webp", buffer: Buffer.from("x") }, S3_ENV))
    .rejects.toThrow("Unable to store avatar");
  expect(metricVal("s3_operations_total", '{operation="put",result="error"}')).toBe(before + 1);
});

test("s3 read hit returns bytes with etag", async () => {
  async function* body() { yield Buffer.from("AB"); yield Buffer.from("CD"); }
  fakeS3(async command => {
    expect(command.constructor.name).toBe("GetObjectCommand");
    return { Body: { [Symbol.asyncIterator]: body }, ETag: '"etag1"', ContentLength: 4 };
  });
  const found = await store.readAvatar("user7-a.webp", S3_ENV);
  expect(found.body.toString()).toBe("ABCD");
  expect(found.etag).toBe('"etag1"');
  expect(found.legacy).toBe(false);
});

test("s3 read miss falls back to legacy local file LOUDLY (counted)", async () => {
  const err = new Error("missing");
  err.Code = "NoSuchKey";
  fakeS3(async () => { throw err; });
  const filename = markerFile();
  await store.writeAvatar({ filename, buffer: Buffer.from("legacy-bytes") }, LOCAL_ENV);
  const before = metricVal("s3_legacy_fallback_reads_total");
  const found = await store.readAvatar(filename, S3_ENV);
  expect(found.body.toString()).toBe("legacy-bytes");
  expect(found.legacy).toBe(true);
  expect(metricVal("s3_legacy_fallback_reads_total")).toBe(before + 1);
  await store.deleteAvatar(filename, LOCAL_ENV);
});

test("s3 read miss with fallback disabled returns null (no hidden local read)", async () => {
  const err = new Error("missing");
  err.Code = "NoSuchKey";
  fakeS3(async () => { throw err; });
  const filename = markerFile();
  await store.writeAvatar({ filename, buffer: Buffer.from("legacy-bytes") }, LOCAL_ENV);
  const found = await store.readAvatar(filename, { ...S3_ENV, AVATAR_S3_LEGACY_FALLBACK: "false" });
  expect(found).toBeNull();
  await store.deleteAvatar(filename, LOCAL_ENV);
});

test("s3 read hard failure throws (never served stale, never silent)", async () => {
  fakeS3(async () => { throw new Error("AccessDenied"); });
  await expect(store.readAvatar("user7-a.webp", S3_ENV)).rejects.toThrow("Unable to read avatar");
});

test("readAvatar rejects unsafe filenames without touching S3", async () => {
  const client = fakeS3(async () => ({}));
  expect(await store.readAvatar("../evil.webp", S3_ENV)).toBeNull();
  expect(await store.readAvatar("user7-a.png", S3_ENV)).toBeNull();
  expect(client.calls).toHaveLength(0);
});

test("s3 delete failure returns false (orphan path) and counts error", async () => {
  fakeS3(async () => { throw new Error("boom"); });
  const before = metricVal("s3_operations_total", '{operation="delete",result="error"}');
  expect(await store.deleteAvatar("user7-a.webp", S3_ENV)).toBe(false);
  expect(metricVal("s3_operations_total", '{operation="delete",result="error"}')).toBe(before + 1);
});
