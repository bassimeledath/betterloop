import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { photoBucket } from "../scripts/backup-paths.mjs";

vi.hoisted(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "00000000000000000000000000000000";
});
const auth = vi.hoisted(() => ({
  token: "fixture-old",
  reads: 0,
  refreshes: 0,
  refreshFails: false,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original();
  return {
    ...fs,
    readFile: async (path, ...args) => {
      if (String(path).endsWith("/.wrangler/config/default.toml")) {
        auth.reads++;
        return [["oauth", "token"].join("_"), JSON.stringify(auth.token)].join(
          " = ",
        );
      }
      return fs.readFile(path, ...args);
    },
  };
});
vi.mock("node:child_process", () => ({
  execFile: (_file, _args, _options, callback) => {
    auth.refreshes++;
    if (auth.refreshFails) callback(new Error("private process diagnostics"));
    else {
      auth.token = "fixture-fresh";
      callback(null, "", "");
    }
  },
}));
import {
  downloadCloudBackup,
  listCloudBackups,
} from "../scripts/r2-backups.mjs";

const hash = (data) => createHash("sha256").update(data).digest("hex");
const parts = [
  Buffer.from("first ciphertext fixture"),
  Buffer.from("second ciphertext fixture"),
];
const id = "betterloop-production-2026-11-04T00-00-00-000Z";
const snapshot = {
  id,
  state: "ready",
  createdAt: Date.now(),
  bytes: Buffer.concat(parts).length,
  sha256: hash(Buffer.concat(parts)),
  chunks: parts.map((p, n) => ({
    key: "snapshots/" + id + "/part-" + String(n + 1).padStart(5, "0"),
    bytes: p.length,
    sha256: hash(p),
  })),
};
const index = () =>
  Response.json({
    format: "betterloop-backup-index-v1",
    snapshots: [snapshot],
  });
let directory;
it("selects source photos by binding even when a different private bucket comes first", () => {
  expect(
    photoBucket({
      r2_buckets: [
        { binding: "BACKUPS", bucket_name: "encrypted-backups" },
        { binding: "PHOTOS", bucket_name: "private-photos" },
      ],
    }),
  ).toBe("private-photos");
  expect(() =>
    photoBucket({
      r2_buckets: [{ binding: "BACKUPS", bucket_name: "encrypted-backups" }],
    }),
  ).toThrow("PHOTOS bucket binding");
});
beforeEach(async () => {
  Object.assign(auth, {
    token: "fixture-old",
    reads: 0,
    refreshes: 0,
    refreshFails: false,
  });
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  await mkdir("work", { recursive: true });
  directory = await mkdtemp(resolve("work/backup-auth-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it("uses a credential rotated between backup parts and preserves every downloaded byte", async () => {
  const seen = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      seen.push(options.headers.Authorization);
      if (url.endsWith("index.json")) {
        auth.token = "fixture-fresh";
        return index();
      }
      const n = Number(url.slice(-5)) - 1;
      return new Response(parts[n]);
    }),
  );
  const file = join(directory, "backup.blbackup");
  await downloadCloudBackup(id, file);
  expect(await readFile(file)).toEqual(Buffer.concat(parts));
  expect(seen).toEqual([
    "Bearer fixture-old",
    "Bearer fixture-fresh",
    "Bearer fixture-fresh",
  ]);
  expect(auth.refreshes).toBe(0);
});
it("refreshes expired OAuth once and resumes the rejected part without corrupting the download", async () => {
  let rejected = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      if (url.endsWith("index.json")) return index();
      if (!rejected) {
        rejected = true;
        return new Response("expired", { status: 401 });
      }
      expect(options.headers.Authorization).toBe("Bearer fixture-fresh");
      return new Response(parts[Number(url.slice(-5)) - 1]);
    }),
  );
  const file = join(directory, "backup.blbackup");
  await downloadCloudBackup(id, file);
  expect(await readFile(file)).toEqual(Buffer.concat(parts));
  expect(auth.refreshes).toBe(1);
});
it("stops after one unsuccessful OAuth refresh instead of looping", async () => {
  const fetch = vi.fn(async () => new Response("forbidden", { status: 403 }));
  vi.stubGlobal("fetch", fetch);
  await expect(listCloudBackups()).rejects.toThrow(
    "R2 backup request failed (403)",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(auth.refreshes).toBe(1);
});
it("leaves explicitly supplied API tokens under operator control", async () => {
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "fixture-managed-token");
  const fetch = vi.fn(async (_url, options) => {
    expect(options.headers.Authorization).toBe("Bearer fixture-managed-token");
    return new Response("forbidden", { status: 403 });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(listCloudBackups()).rejects.toThrow(
    "R2 backup request failed (403)",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(auth.refreshes).toBe(0);
  expect(auth.reads).toBe(0);
});
it("reports refresh failure without exposing child-process diagnostics", async () => {
  auth.refreshFails = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("expired", { status: 401 })),
  );
  await expect(listCloudBackups()).rejects.toMatchObject({
    message:
      "Cloudflare authentication could not be refreshed. Run wrangler login and retry the backup.",
  });
  expect(auth.refreshes).toBe(1);
});
