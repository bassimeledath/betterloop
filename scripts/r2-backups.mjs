// One operator runner owns this bucket's index. Only ciphertext goes to R2.
import { readFile, writeFile, mkdir, open, stat, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { supportDirectory, applicationRoot } from "./backup-paths.mjs";
const run = promisify(execFile);
const account = process.env.CLOUDFLARE_ACCOUNT_ID || "",
  DAY = 86400000;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validId = (id) => /^betterloop-(production|local)-[\dTZ-]+$/.test(id);
export async function cloudBucketClient(bucket, accountId = account) {
  if (!/^[a-z0-9-]{3,63}$/.test(bucket))
    throw new Error("Invalid backup bucket name.");
  if (!/^[a-f0-9]{32}$/i.test(accountId))
    throw new Error("Invalid Cloudflare account ID.");
  const fixedToken = process.env.CLOUDFLARE_API_TOKEN;
  const credential = async () => {
    if (fixedToken) return fixedToken;
    const credentialPath =
      process.env.BETTERLOOP_WRANGLER_CONFIG ||
      (process.platform === "darwin"
        ? join(
            process.env.HOME,
            "Library/Preferences/.wrangler/config/default.toml",
          )
        : null);
    if (!credentialPath)
      throw new Error(
        "Set CLOUDFLARE_API_TOKEN or BETTERLOOP_WRANGLER_CONFIG for this backup runner.",
      );
    const text = await readFile(credentialPath, "utf8");
    const token = text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
    if (!token) throw new Error("Cloudflare authentication is required.");
    return token;
  };
  return async (key, { method = "GET", body } = {}) => {
    const request = async () =>
      fetch(
        "https://api.cloudflare.com/client/v4/accounts/" +
          accountId +
          "/r2/buckets/" +
          bucket +
          "/objects/" +
          key.split("/").map(encodeURIComponent).join("/"),
        {
          method,
          headers: {
            Authorization: "Bearer " + (await credential()),
            "Content-Type": "application/octet-stream",
          },
          body,
          signal: AbortSignal.timeout(120000),
        },
      );
    let response = await request();
    if (!fixedToken && [401, 403].includes(response.status)) {
      await response.arrayBuffer();
      try {
        await run("npx", ["wrangler", "whoami"], {
          cwd: applicationRoot,
          timeout: 60000,
          maxBuffer: 100000,
        });
      } catch {
        throw new Error(
          "Cloudflare authentication could not be refreshed. Run wrangler login and retry the backup.",
        );
      }
      // Bodies here are replayable buffers; an authorization rejection did not accept the write.
      response = await request();
    }
    if (response.status === 404 && ["GET", "DELETE"].includes(method)) {
      await response.arrayBuffer();
      return null;
    }
    if (!response.ok)
      throw new Error("R2 backup request failed (" + response.status + ").");
    if (method !== "GET") {
      await response.arrayBuffer();
      return null;
    }
    return response;
  };
}
async function index(api) {
  const response = await api("index.json");
  if (!response) return { format: "betterloop-backup-index-v1", snapshots: [] };
  const data = await response.json();
  if (
    data.format !== "betterloop-backup-index-v1" ||
    !Array.isArray(data.snapshots)
  )
    throw new Error("Unknown cloud backup index.");
  for (const s of data.snapshots) {
    if (
      !validId(s.id) ||
      !["uploading", "ready"].includes(s.state) ||
      !Number.isSafeInteger(s.bytes) ||
      s.bytes < 1 ||
      !Number.isFinite(s.createdAt) ||
      !Array.isArray(s.chunks) ||
      !/^[a-f0-9]{64}$/.test(s.sha256)
    )
      throw new Error("Invalid cloud snapshot metadata.");
    let bytes = 0;
    for (const [i, c] of s.chunks.entries()) {
      if (
        c.key !==
          "snapshots/" + s.id + "/part-" + String(i + 1).padStart(5, "0") ||
        !Number.isSafeInteger(c.bytes) ||
        c.bytes < 1 ||
        !/^[a-f0-9]{64}$/.test(c.sha256)
      )
        throw new Error("Invalid cloud backup part.");
      bytes += c.bytes;
    }
    if (bytes !== s.bytes) throw new Error("Cloud snapshot size mismatch.");
  }
  return data;
}
const save = (api, data) =>
  api("index.json", { method: "PUT", body: Buffer.from(JSON.stringify(data)) });
async function exclusive(bucket, work) {
  await mkdir(supportDirectory, { recursive: true, mode: 0o700 });
  const path = join(supportDirectory, "r2-" + bucket);
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 120000,
    update: 10000,
    retries: 0,
  });
  try {
    return await work();
  } finally {
    await release();
  }
}
async function drop(api, snapshot) {
  for (const part of snapshot.chunks) await api(part.key, { method: "DELETE" });
}
export async function listCloudBackups(bucket = "betterloop-backups") {
  return (await index(await cloudBucketClient(bucket))).snapshots;
}
export async function uploadCloudBackup(
  file,
  {
    bucket = "betterloop-backups",
    maxBytes = 4000000000,
    chunkSize = 64 * 1024 * 1024,
  } = {},
) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > 64 * 1024 * 1024
  )
    throw new Error("Invalid backup storage limits.");
  return exclusive(bucket, async () => {
    const api = await cloudBucketClient(bucket),
      data = await index(api),
      stamp = Date.now();
    for (const snapshot of [...data.snapshots])
      if (
        snapshot.createdAt < stamp - 30 * DAY ||
        (snapshot.state === "uploading" && snapshot.createdAt < stamp - DAY)
      ) {
        await drop(api, snapshot);
        data.snapshots = data.snapshots.filter((s) => s.id !== snapshot.id);
        await save(api, data);
      }
    const id = basename(file, ".blbackup"),
      bytes = (await stat(file)).size;
    if (!validId(id)) throw new Error("Invalid backup filename.");
    const existing = data.snapshots.find((s) => s.id === id);
    if (existing)
      throw new Error(
        "This snapshot already exists; choose a new backup filename.",
      );
    if (data.snapshots.reduce((n, s) => n + s.bytes, 0) + bytes > maxBytes)
      throw new Error(
        "Cloud backups reached their 4 GB storage cap; the verified local copy is retained.",
      );
    const handle = await open(file, "r"),
      whole = createHash("sha256"),
      chunks = [];
    try {
      for (let offset = 0; offset < bytes; offset += chunkSize) {
        const part = Buffer.alloc(Math.min(chunkSize, bytes - offset));
        const result = await handle.read(part, 0, part.length, offset);
        if (result.bytesRead !== part.length)
          throw new Error("Backup changed while reading.");
        whole.update(part);
        chunks.push({
          key:
            "snapshots/" +
            id +
            "/part-" +
            String(chunks.length + 1).padStart(5, "0"),
          bytes: part.length,
          sha256: sha(part),
        });
      }
    } finally {
      await handle.close();
    }
    const snapshot = {
      id,
      state: "uploading",
      createdAt: stamp,
      bytes,
      sha256: whole.digest("hex"),
      chunks,
    };
    // Reserve all part keys and bytes first so interrupted uploads remain accountable.
    data.snapshots.push(snapshot);
    await save(api, data);
    const source = await open(file, "r");
    try {
      let offset = 0;
      for (const part of chunks) {
        const body = Buffer.alloc(part.bytes);
        const result = await source.read(body, 0, body.length, offset);
        if (result.bytesRead !== body.length || sha(body) !== part.sha256)
          throw new Error("Backup changed while uploading.");
        await api(part.key, { method: "PUT", body });
        const remote = await api(part.key);
        const stored = remote ? Buffer.from(await remote.arrayBuffer()) : null;
        if (
          !stored ||
          stored.length !== part.bytes ||
          sha(stored) !== part.sha256
        )
          throw new Error("Cloud backup verification failed.");
        offset += part.bytes;
      }
    } finally {
      await source.close();
    }
    snapshot.state = "ready";
    await save(api, data);
    return {
      bucket,
      snapshot: id,
      bytes,
      parts: chunks.length,
      remoteVerification: "passed",
    };
  });
}
export async function downloadCloudBackup(
  id,
  file,
  { bucket = "betterloop-backups" } = {},
) {
  const api = await cloudBucketClient(bucket),
    snapshot = (await index(api)).snapshots.find(
      (s) => s.id === id && s.state === "ready",
    );
  if (!snapshot) throw new Error("Ready cloud snapshot not found.");
  const target = await open(file, "wx", 0o600),
    whole = createHash("sha256");
  let complete = false;
  try {
    for (const part of snapshot.chunks) {
      const response = await api(part.key);
      const bytes = response ? Buffer.from(await response.arrayBuffer()) : null;
      if (!bytes || bytes.length !== part.bytes || sha(bytes) !== part.sha256)
        throw new Error("Cloud backup part failed verification.");
      whole.update(bytes);
      await target.writeFile(bytes);
    }
    if (whole.digest("hex") !== snapshot.sha256)
      throw new Error("Cloud backup checksum mismatch.");
    complete = true;
    return {
      snapshot: id,
      bytes: snapshot.bytes,
      parts: snapshot.chunks.length,
    };
  } finally {
    await target.close();
    if (!complete) await rm(file, { force: true });
  }
}
export async function removeCloudSnapshot(
  id,
  { bucket = "betterloop-backups" } = {},
) {
  return exclusive(bucket, async () => {
    const api = await cloudBucketClient(bucket),
      data = await index(api),
      snapshot = data.snapshots.find((s) => s.id === id);
    if (!snapshot) throw new Error("Cloud snapshot not found.");
    await drop(api, snapshot);
    data.snapshots = data.snapshots.filter((s) => s.id !== id);
    await save(api, data);
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, ...args] = process.argv.slice(2),
    option = (name, fallback) => {
      const i = args.indexOf(name);
      return i < 0 ? fallback : args[i + 1];
    },
    bucket = option("--bucket", "betterloop-backups");
  try {
    if (mode === "list")
      console.log(JSON.stringify(await listCloudBackups(bucket)));
    else if (mode === "download")
      console.log(
        JSON.stringify(
          await downloadCloudBackup(
            option("--snapshot"),
            resolve(option("--file")),
            { bucket },
          ),
        ),
      );
    else
      throw new Error(
        "Usage: node scripts/r2-backups.mjs list [--bucket NAME] | download --snapshot ID --file PATH [--bucket NAME]",
      );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
