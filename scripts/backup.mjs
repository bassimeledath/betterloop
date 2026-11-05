// Encrypted, operator-run D1 + private media backup. Requires Node 22 and Python 3.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  stat,
  mkdtemp,
  rm,
  readdir,
  open,
  cp,
} from "node:fs/promises";
import {
  uploadCloudBackup,
  listCloudBackups,
  cloudBucketClient,
} from "./r2-backups.mjs";
import { parse as parseJsonc } from "jsonc-parser";
import {
  defaultBackupKeyPath,
  defaultBackupDirectory,
  photoBucket,
} from "./backup-paths.mjs";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2),
  mode = args.shift(),
  option = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
const local = args.includes("--local"),
  config = option(
    "--config",
    local ? "wrangler.local.jsonc" : "wrangler.jsonc",
  );
const keyFile = resolve(option("--key-file", defaultBackupKeyPath)),
  directory = resolve(option("--directory", defaultBackupDirectory));
const magic = Buffer.from("BETTERLOOP-BACKUP-1\n");
async function command(cmd, argv, { input, stdout } = {}) {
  const child = spawn(cmd, argv, {
    cwd: root,
    stdio: ["pipe", stdout ? "pipe" : "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (d) => (errors += d));
  const done = new Promise((yes, no) => {
    child.on("error", no);
    child.on("close", (code) =>
      code === 0
        ? yes()
        : no(new Error(cmd + " failed: " + errors.slice(-500))),
    );
  });
  if (input) child.stdin.end(input);
  else child.stdin.end();
  if (stdout) await Promise.all([pipeline(child.stdout, stdout), done]);
  else await done;
}
async function key(create = false) {
  try {
    const b = await readFile(keyFile);
    if (b.length !== 32)
      throw new Error("Backup key must contain exactly 32 bytes.");
    return b;
  } catch (e) {
    if (e.code !== "ENOENT" || !create) throw e;
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    let b = randomBytes(32);
    if (keyFile === defaultBackupKeyPath) {
      try {
        const legacy = await readFile(join(root, "work", "backup-key"));
        if (legacy.length === 32) b = legacy;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    await writeFile(keyFile, b, { mode: 0o600, flag: "wx" });
    return b;
  }
}
async function digest(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
async function inspect(sql, database) {
  let result = "";
  const code =
    "import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[2]);c.executescript(open(sys.argv[1]).read());c.row_factory=sqlite3.Row\nprint(json.dumps([dict(x) for x in c.execute(\"SELECT id,object_key,bytes FROM assets WHERE state='ready' ORDER BY id\")]))";
  await command("python3", ["-c", code, sql, database], {
    stdout: new (await import("node:stream")).Writable({
      write(c, _e, cb) {
        result += c;
        cb();
      },
    }),
  });
  return JSON.parse(result);
}
async function verify(file, k, destination) {
  await mkdir(join(root, "work"), { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(root, "work", "restore-"));
  try {
    const length = (await stat(file)).size;
    if (length < magic.length + 12 + 16) throw new Error("Truncated backup.");
    const handle = await open(file, "r");
    const header = Buffer.alloc(magic.length + 12),
      tag = Buffer.alloc(16);
    try {
      await handle.read(header, 0, header.length, 0);
      await handle.read(tag, 0, 16, length - 16);
    } finally {
      await handle.close();
    }
    if (!header.subarray(0, magic.length).equals(magic))
      throw new Error("Unknown backup format.");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      k,
      header.subarray(magic.length),
    );
    decipher.setAAD(magic);
    decipher.setAuthTag(tag);
    const tar = join(temp, "snapshot.tar.gz");
    await pipeline(
      createReadStream(file, { start: header.length, end: length - 17 }),
      decipher,
      createWriteStream(tar, { mode: 0o600 }),
    );
    const extracted = join(temp, "snapshot");
    await mkdir(extracted, { mode: 0o700 });
    await command("tar", ["-xzf", tar, "-C", extracted]);
    const manifest = JSON.parse(
      await readFile(join(extracted, "manifest.json"), "utf8"),
    );
    if (manifest.format !== "betterloop-backup-v1")
      throw new Error("Unknown manifest.");
    for (const f of manifest.files) {
      if (!/^(database\.sql|photos\/[a-f0-9-]+\.jpg)$/.test(f.path))
        throw new Error("Invalid backup path.");
      const p = join(extracted, f.path);
      if ((await stat(p)).size !== f.bytes || (await digest(p)) !== f.sha256)
        throw new Error("Backup file mismatch.");
    }
    const restored = join(temp, "restored.sqlite");
    const photos = await inspect(join(extracted, "database.sql"), restored);
    if (photos.length !== manifest.photos.length)
      throw new Error("Photo catalog mismatch.");
    for (const photo of photos) {
      if (
        !manifest.photos.some(
          (p) =>
            p.id === photo.id &&
            p.objectKey === photo.object_key &&
            p.bytes === photo.bytes,
        )
      )
        throw new Error("Photo reference mismatch.");
    }
    // Verification restores into an isolated SQLite database only. It never enables mail.
    await command("python3", [
      join(root, "scripts", "sanitize_restore.py"),
      restored,
    ]);
    if (destination) {
      await mkdir(destination, { mode: 0o700 });
      await cp(join(extracted, "photos"), join(destination, "photos"), {
        recursive: true,
      });
      await cp(
        join(extracted, "manifest.json"),
        join(destination, "manifest.json"),
      );
      await cp(restored, join(destination, "restored.sqlite"));
      await command("python3", [
        join(root, "scripts", "restore_sql.py"),
        restored,
        join(destination, "database.sql"),
      ]);
      await writeFile(
        join(destination, "RESTORE-NOTES.txt"),
        "Isolated recovery copy. All groups are paused; sessions, sign-in tokens and pending signups are removed; shared group links are closed; temporary exports are expired; every historical outbox message is skipped. This copy must stay private. Before any production restore, reconcile against the current deletion ledger and membership/ownership changes, keep EMAIL_MODE=disabled, and compare historical provider receipts. Do not deploy or enable email from this directory automatically.\n",
        { mode: 0o600 },
      );
    }
    return {
      format: manifest.format,
      photos: photos.length,
      files: manifest.files.length,
      createdAt: manifest.createdAt,
      isolatedRestore: "passed",
      outbound: "disabled",
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
async function create() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "work"), { recursive: true, mode: 0o700 });
  const k = await key(true),
    temp = await mkdtemp(join(root, "work", "backup-"));
  let file,
    verified = false;
  try {
    const snapshot = join(temp, "snapshot");
    await mkdir(join(snapshot, "photos"), { recursive: true, mode: 0o700 });
    const sql = join(snapshot, "database.sql");
    await command("npx", [
      "wrangler",
      "d1",
      "export",
      "DB",
      local ? "--local" : "--remote",
      "--config",
      config,
      "--output",
      sql,
    ]);
    const photos = await inspect(sql, join(temp, "catalog.sqlite")),
      manifest = {
        format: "betterloop-backup-v1",
        createdAt: new Date().toISOString(),
        source: local ? "local" : "production",
        photos: [],
        files: [],
      };
    const settings = parseJsonc(await readFile(resolve(root, config), "utf8")),
      bucket = photoBucket(settings),
      photoClient = local
        ? null
        : await cloudBucketClient(bucket, settings.account_id);
    for (const photo of photos) {
      const path = "photos/" + photo.id + ".jpg",
        target = join(snapshot, path);
      if (local)
        await command("npx", [
          "wrangler",
          "r2",
          "object",
          "get",
          bucket + "/" + photo.object_key,
          "--local",
          "--config",
          config,
          "--file",
          target,
        ]);
      else {
        const r = await photoClient(photo.object_key);
        if (!r)
          throw new Error("A snapshot photo is unavailable; retry the backup.");
        await pipeline(r.body, createWriteStream(target, { mode: 0o600 }));
      }
      if ((await stat(target)).size !== photo.bytes)
        throw new Error("Photo size changed; retry the backup.");
      manifest.photos.push({
        id: photo.id,
        objectKey: photo.object_key,
        bytes: photo.bytes,
      });
    }
    for (const path of [
      "database.sql",
      ...manifest.photos.map((p) => "photos/" + p.id + ".jpg"),
    ])
      manifest.files.push({
        path,
        bytes: (await stat(join(snapshot, path))).size,
        sha256: await digest(join(snapshot, path)),
      });
    await writeFile(
      join(snapshot, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    const stamp = manifest.createdAt.replaceAll(/[:.]/g, "-");
    file = join(
      directory,
      "betterloop-" + (local ? "local-" : "production-") + stamp + ".blbackup",
    );
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", k, nonce);
    cipher.setAAD(magic);
    await writeFile(file, Buffer.concat([magic, nonce]), {
      mode: 0o600,
      flag: "wx",
    });
    await Promise.all([
      command("tar", ["-czf", "-", "-C", snapshot, "."], { stdout: cipher }),
      pipeline(cipher, createWriteStream(file, { flags: "a", mode: 0o600 })),
    ]);
    await appendFile(file, cipher.getAuthTag());
    const receipt = await verify(file, k);
    verified = true;
    const cutoff = Date.now() - 30 * 86400000;
    for (const name of await readdir(directory)) {
      if (/^betterloop-(local|production)-[\dTZ-]+\.blbackup$/.test(name)) {
        const path = join(directory, name);
        if ((await stat(path)).mtimeMs < cutoff) await rm(path);
      }
    }
    const cloudBucket = option("--r2");
    const cloud = cloudBucket
      ? await uploadCloudBackup(file, { bucket: cloudBucket })
      : undefined;
    console.log(
      JSON.stringify({
        backup: file,
        cloud,
        keyFile,
        bytes: (await stat(file)).size,
        ...receipt,
      }),
    );
  } catch (e) {
    if (file && !verified) await rm(file, { force: true });
    if (verified) e.message += " Verified local copy retained at " + file;
    throw e;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
try {
  if (mode === "create") {
    let skip = false;
    if (args.includes("--scheduled") && option("--r2")) {
      await command("npx", ["wrangler", "whoami"]);
      const ready = (await listCloudBackups(option("--r2"))).filter(
        (s) => s.state === "ready" && s.createdAt > Date.now() - 30 * 86400000,
      );
      if (ready.length) {
        await key();
        const anchor = new Date();
        anchor.setDate(anchor.getDate() - anchor.getDay());
        anchor.setHours(9, 0, 0, 0);
        if (anchor.getTime() > Date.now()) anchor.setDate(anchor.getDate() - 7);
        skip = ready.some((s) => s.createdAt >= anchor.getTime());
      }
      if (skip)
        console.log(
          JSON.stringify({
            skipped: true,
            reason: "A verified cloud backup already covers this weekly window",
          }),
        );
    }
    if (!skip) await create();
  } else if (mode === "verify" || mode === "restore") {
    const file = option("--file");
    if (!file) throw new Error("Supply --file <backup>.");
    const destination = option("--destination");
    if (mode === "restore" && !destination)
      throw new Error(
        "Supply a new --destination directory for the isolated recovery copy.",
      );
    console.log(
      JSON.stringify(
        await verify(
          resolve(file),
          await key(),
          mode === "restore" ? resolve(destination) : undefined,
        ),
      ),
    );
  } else
    throw new Error(
      "Usage: node scripts/backup.mjs create [--local] [--directory PATH] [--key-file PATH] | verify --file PATH [--key-file PATH]",
    );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
