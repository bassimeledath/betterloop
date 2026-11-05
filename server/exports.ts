import { Hono, type Context } from "hono";
import { z } from "zod";
import type { App, Env, Publication, Update } from "./types";
import { id, now, member, fail } from "./security";
import { redactPublication } from "./privacy";
export const exportRoutes = new Hono<App>();
const PART = 5 * 1024 * 1024,
  BUFFER_ALLOWANCE = 12 * 1024 * 1024;
type Job = {
  id: string;
  user_id: string;
  group_id: string | null;
  kind: "group" | "personal";
  state: string;
  source_cursor: string;
  file_cursor: number;
  upload_id: string | null;
  buffer_key: string | null;
  parts_json: string;
  bytes: number;
  lease_token: string | null;
  lease_until: number | null;
  revision: number;
  error_code: string | null;
  created_at: number;
  expires_at: number;
};
type FileEntry = {
  id: number;
  path: string;
  payload_json: string | null;
  asset_id: string | null;
  bytes: number;
};
const encoder = new TextEncoder();
export function tarHeader(path: string, size: number, stamp: number) {
  const b = new Uint8Array(512);
  const write = (s: string, at: number, len: number) =>
    b.set(encoder.encode(s).slice(0, len), at);
  write(path, 0, 100);
  write("0000600\0", 100, 8);
  write("0000000\0", 108, 8);
  write("0000000\0", 116, 8);
  write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  write(
    Math.floor(stamp / 1000)
      .toString(8)
      .padStart(11, "0") + "\0",
    136,
    12,
  );
  b.fill(32, 148, 156);
  b[156] = 48;
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  write("betterloop", 265, 32);
  write("betterloop", 297, 32);
  write(
    b
      .reduce((s, v) => s + v, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
    8,
  );
  return b;
}
const join = (...arrays: Uint8Array[]) => {
  const b = new Uint8Array(arrays.reduce((n, a) => n + a.byteLength, 0));
  let p = 0;
  for (const a of arrays) {
    b.set(a, p);
    p += a.byteLength;
  }
  return b;
};
const key = (j: Job) => "exports/" + j.id + "/archive.tar";
async function allowed(env: Env, j: Job) {
  const user = await env.DB.prepare(
    "SELECT id FROM users WHERE id=? AND deleted_at IS NULL",
  )
    .bind(j.user_id)
    .first();
  if (!user) return false;
  if (j.kind === "group") {
    const owner = await env.DB.prepare(
      "SELECT g.id FROM groups g JOIN memberships m ON m.group_id=g.id WHERE g.id=? AND g.owner_id=? AND g.deleted_at IS NULL AND m.user_id=? AND m.active=1 AND m.role='owner'",
    )
      .bind(j.group_id, j.user_id, j.user_id)
      .first();
    if (!owner) return false;
    const changed = await env.DB.prepare(
      "SELECT id FROM deletion_records WHERE created_at>=? AND (group_id=? OR user_id IN (SELECT user_id FROM memberships WHERE group_id=?)) LIMIT 1",
    )
      .bind(j.created_at, j.group_id, j.group_id)
      .first();
    if (changed) return false;
  }
  return true;
}
async function create(
  env: Env,
  userId: string,
  groupId: string | null,
  requestId?: string,
) {
  if (!env.PHOTOS)
    fail(
      503,
      "The host needs to configure private storage before exports are available.",
    );
  const creationKey = requestId
    ? userId + ":" + (groupId || "personal") + ":" + requestId
    : null;
  const replay = async () =>
    creationKey
      ? await env.DB.prepare(
          "SELECT id FROM exports WHERE creation_key=? AND user_id=? AND group_id IS ?",
        )
          .bind(creationKey, userId, groupId)
          .first<{ id: string }>()
      : null;
  const prior = await replay();
  if (prior) return { id: prior.id, created: false };
  const jid = id(),
    stamp = now();
  const meta = groupId
    ? {
        format: "betterloop-export-v1",
        kind: "group",
        group: await env.DB.prepare(
          "SELECT id,name,description,timezone,cadence FROM groups WHERE id=?",
        )
          .bind(groupId)
          .first(),
        members: (
          await env.DB.prepare(
            "SELECT u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND m.active=1",
          )
            .bind(groupId)
            .all()
        ).results,
      }
    : {
        format: "betterloop-export-v1",
        kind: "personal",
        profile: await env.DB.prepare(
          "SELECT name,email,created_at FROM users WHERE id=?",
        )
          .bind(userId)
          .first(),
      };
  const json = JSON.stringify(meta, null, 2);
  const statements = [
    env.DB.prepare(
      "INSERT OR IGNORE INTO exports(id,user_id,group_id,kind,created_at,expires_at,creation_key) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM exports WHERE user_id=? AND state IN ('planning','building') AND expires_at>?) AND (SELECT COUNT(*) FROM exports WHERE user_id=? AND created_at>=?)<3 RETURNING id",
    ).bind(
      jid,
      userId,
      groupId,
      groupId ? "group" : "personal",
      stamp,
      stamp + 86400000,
      creationKey,
      userId,
      userId,
      stamp,
      userId,
      Math.floor(stamp / 86400000) * 86400000,
    ),
    env.DB.prepare(
      "INSERT INTO export_files(job_id,path,payload_json,bytes) SELECT id,?,?,? FROM exports WHERE id=?",
    ).bind("manifest.json", json, encoder.encode(json).byteLength, jid),
  ];
  if (!groupId)
    statements.push(
      env.DB.prepare(
        `INSERT INTO export_files(job_id,path,payload_json,bytes)
  SELECT ?, 'my-updates/'||issue_id||'.json',payload,length(CAST(payload AS BLOB)) FROM (
   SELECT c.issue_id,json_object('issueId',c.issue_id,'groupId',c.group_id,'title',i.title,'questions',json((SELECT json_group_array(json_object('id',q.id,'text',q.text,'author_name',q.author_name)) FROM issue_questions q WHERE q.issue_id=c.issue_id)),'draft',json(c.draft_json),'submitted',CASE WHEN c.submitted_json IS NULL THEN NULL ELSE json(c.submitted_json) END) AS payload
   FROM contributions c JOIN issues i ON i.id=c.issue_id WHERE c.user_id=?
  ) WHERE EXISTS(SELECT 1 FROM exports WHERE id=?)`,
      ).bind(jid, userId, jid),
    );
  if (!groupId)
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO export_files(job_id,path,asset_id,bytes)
    SELECT ?, 'photos/'||a.id||'.jpg',a.id,a.bytes FROM assets a WHERE a.user_id=? AND a.state='ready' AND a.id IN (
      SELECT json_extract(p.value,'$.id') FROM export_files f,json_each(f.payload_json,'$.draft.photos') p WHERE f.job_id=? AND f.path LIKE 'my-updates/%'
      UNION SELECT json_extract(p.value,'$.id') FROM export_files f,json_each(f.payload_json,'$.submitted.photos') p WHERE f.job_id=? AND f.path LIKE 'my-updates/%'
    )`,
      ).bind(jid, userId, jid, jid),
    );
  const inserted = await env.DB.batch(statements);
  if (!inserted[0].results.length) {
    const created = await replay();
    if (created) return { id: created.id, created: false };
    const daily = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM exports WHERE user_id=? AND created_at>=?",
    )
      .bind(userId, Math.floor(stamp / 86400000) * 86400000)
      .first<{ n: number }>();
    if (daily!.n >= 3)
      fail(
        429,
        "You can prepare up to three archives per day. Existing downloads are still available.",
      );
    fail(409, "An export is already being prepared. Wait for it to finish.");
  }
  return { id: jid, created: true };
}
const exportRequest = z.object({ requestId: z.uuid().optional() });
async function creationRequestId(c: Context<App>) {
  const raw = await c.req.text();
  let input: unknown;
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    fail(400, "Use a valid export request.");
  }
  return exportRequest.parse(input).requestId;
}
exportRoutes.post("/me/exports", async (c) => {
  const result = await create(
    c.env,
    c.get("session").user.id,
    null,
    await creationRequestId(c),
  );
  return c.json({ id: result.id }, result.created ? 201 : 200);
});
exportRoutes.post("/groups/:groupId/exports", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner"]);
  const result = await create(
    c.env,
    c.get("session").user.id,
    gid,
    await creationRequestId(c),
  );
  return c.json({ id: result.id }, result.created ? 201 : 200);
});
exportRoutes.get("/exports", async (c) => {
  const jobs = (
    await c.env.DB.prepare(
      "SELECT id,kind,group_id,state,bytes,error_code,created_at,expires_at FROM exports WHERE user_id=? ORDER BY created_at DESC LIMIT 20",
    )
      .bind(c.get("session").user.id)
      .all()
  ).results;
  return c.json({ exports: jobs });
});
exportRoutes.get("/exports/:id", async (c) => {
  const j = await c.env.DB.prepare(
    "SELECT * FROM exports WHERE id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("session").user.id)
    .first<Job>();
  if (!j) fail(404, "Export not found.");
  const valid = j.expires_at > now() && (await allowed(c.env, j));
  return c.json({
    export: {
      id: j.id,
      kind: j.kind,
      state: valid ? j.state : "expired",
      bytes: j.bytes,
      errorCode: j.error_code,
      expiresAt: j.expires_at,
    },
  });
});
exportRoutes.get("/exports/:id/download", async (c) => {
  const j = await c.env.DB.prepare(
    "SELECT * FROM exports WHERE id=? AND user_id=? AND state='ready' AND expires_at>?",
  )
    .bind(c.req.param("id"), c.get("session").user.id, now())
    .first<Job>();
  if (!j || !(await allowed(c.env, j)))
    fail(
      404,
      "This export expired or your access changed. Request a fresh export.",
    );
  const object = await c.env.PHOTOS?.get(key(j));
  if (!object) fail(404, "This export is no longer available.");
  c.header("Content-Type", "application/x-tar");
  c.header(
    "Content-Disposition",
    'attachment; filename="betterloop-' + j.kind + "-" + j.id + '.tar"',
  );
  c.header("Content-Length", String(object.size));
  c.header("Cache-Control", "private, no-store");
  return new Response(object.body, { headers: c.res.headers });
});
async function addAssets(env: Env, j: Job, photos: { id: string }[]) {
  if (!photos.length) return;
  const ids = [...new Set(photos.map((p) => p.id))],
    json = JSON.stringify(ids),
    scope =
      "state='ready' AND (? IS NULL AND user_id=? OR group_id=?) AND id IN (SELECT value FROM json_each(?))";
  // Pin the whole issue in one transaction, including a full twenty-person photo wall.
  const [found] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE " + scope).bind(
      j.group_id,
      j.user_id,
      j.group_id,
      json,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO export_files(job_id,path,asset_id,bytes) SELECT ?, 'photos/'||id||'.jpg',id,bytes FROM assets WHERE " +
        scope,
    ).bind(j.id, j.group_id, j.user_id, j.group_id, json),
  ]);
  if (found.results[0]?.n !== ids.length)
    throw new Error("export_photo_missing");
}
async function planStep(env: Env, j: Job, lease: string) {
  if (j.kind === "group") {
    const p = await env.DB.prepare(
      "SELECT issue_id,content_json FROM publications WHERE group_id=? AND issue_id>? AND published_at<=? ORDER BY issue_id LIMIT 1",
    )
      .bind(j.group_id, j.source_cursor, j.created_at)
      .first<{ issue_id: string; content_json: string }>();
    if (p) {
      const content = await redactPublication(
          env,
          JSON.parse(p.content_json) as Publication,
        ),
        json = JSON.stringify(content, null, 2);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO export_files(job_id,path,payload_json,bytes) VALUES(?,?,?,?)",
      )
        .bind(
          j.id,
          "issues/" + p.issue_id + ".json",
          json,
          encoder.encode(json).byteLength,
        )
        .run();
      await addAssets(
        env,
        j,
        content.contributors.flatMap((p) => p.update.photos),
      );
      await env.DB.prepare(
        "UPDATE exports SET source_cursor=?,lease_until=NULL,lease_token=NULL,revision=revision+1 WHERE id=? AND lease_token=? AND state='planning'",
      )
        .bind(p.issue_id, j.id, lease)
        .run();
      return;
    }
  } else {
    const p = await env.DB.prepare(
      "SELECT id,payload_json FROM export_files WHERE job_id=? AND path LIKE 'my-updates/%' AND id>? ORDER BY id LIMIT 1",
    )
      .bind(j.id, Number(j.source_cursor || 0))
      .first<{ id: number; payload_json: string }>();
    if (p) {
      const { draft, submitted } = JSON.parse(p.payload_json) as {
        draft: Update;
        submitted: Update | null;
      };
      await addAssets(env, j, [...draft.photos, ...(submitted?.photos || [])]);
      await env.DB.prepare(
        "UPDATE exports SET source_cursor=?,lease_until=NULL,lease_token=NULL,revision=revision+1 WHERE id=? AND lease_token=? AND state='planning'",
      )
        .bind(String(p.id), j.id, lease)
        .run();
      return;
    }
  }
  const size = await env.DB.prepare(
    "SELECT COALESCE(SUM(512+((bytes+511)/512)*512),0)+1024 AS n FROM export_files WHERE job_id=?",
  )
    .bind(j.id)
    .first<{ n: number }>();
  const r = await env.DB.prepare(
    "UPDATE exports SET state='building',bytes=?,lease_until=NULL,lease_token=NULL,revision=revision+1 WHERE id=? AND lease_token=? AND state='planning' AND (SELECT COALESCE(SUM(bytes),0) FROM assets)+(SELECT COALESCE(SUM(bytes+?),0) FROM exports WHERE id!=? AND state IN ('building','ready') AND expires_at>?)+?+?<=5000000000 RETURNING id",
  )
    .bind(
      size!.n,
      j.id,
      lease,
      BUFFER_ALLOWANCE,
      j.id,
      now(),
      size!.n,
      BUFFER_ALLOWANCE,
    )
    .first();
  if (!r) throw new Error("export_storage_limit");
}
async function buildStep(env: Env, j: Job, lease: string) {
  const bucket = env.PHOTOS!;
  const done = await bucket.head(key(j));
  if (done && done.size === j.bytes) {
    await env.DB.prepare(
      "UPDATE exports SET state='ready',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND state='building'",
    )
      .bind(j.id, lease)
      .run();
    return;
  }
  let uploadId = j.upload_id;
  if (!uploadId) {
    const upload = await bucket.createMultipartUpload(key(j), {
      httpMetadata: { contentType: "application/x-tar" },
      customMetadata: { exportId: j.id },
    });
    uploadId = upload.uploadId;
    const r = await env.DB.prepare(
      "UPDATE exports SET upload_id=? WHERE id=? AND lease_token=? AND upload_id IS NULL AND state='building' RETURNING id",
    )
      .bind(uploadId, j.id, lease)
      .first();
    if (!r) {
      await upload.abort();
      return;
    }
  }
  const upload = bucket.resumeMultipartUpload(key(j), uploadId),
    parts = JSON.parse(j.parts_json) as R2UploadedPart[];
  let buffer = j.buffer_key
    ? new Uint8Array(await (await bucket.get(j.buffer_key))!.arrayBuffer())
    : new Uint8Array(0);
  const entry = await env.DB.prepare(
    "SELECT * FROM export_files WHERE job_id=? AND id>? ORDER BY id LIMIT 1",
  )
    .bind(j.id, j.file_cursor)
    .first<FileEntry>();
  if (entry) {
    let bytes: Uint8Array;
    if (entry.asset_id) {
      const a = await env.DB.prepare(
        "SELECT object_key FROM assets WHERE id=? AND state='ready'",
      )
        .bind(entry.asset_id)
        .first<{ object_key: string }>();
      if (!a) throw new Error("export_photo_missing");
      const object = await bucket.get(a.object_key);
      if (!object) throw new Error("export_photo_missing");
      bytes = new Uint8Array(await object.arrayBuffer());
    } else bytes = encoder.encode(entry.payload_json!);
    if (bytes.byteLength !== entry.bytes)
      throw new Error("export_source_changed");
    buffer = join(
      buffer,
      tarHeader(entry.path, bytes.byteLength, j.created_at),
      bytes,
      new Uint8Array((512 - (bytes.byteLength % 512)) % 512),
    );
  } else buffer = join(buffer, new Uint8Array(1024));
  if (buffer.byteLength >= PART) {
    parts.push(
      await upload.uploadPart(parts.length + 1, buffer.subarray(0, PART)),
    );
    buffer = buffer.subarray(PART);
  }
  if (!entry) {
    if (buffer.byteLength)
      parts.push(await upload.uploadPart(parts.length + 1, buffer));
    const object = await upload.complete(parts);
    if (object.size !== j.bytes) throw new Error("export_size_mismatch");
    await env.DB.prepare(
      "UPDATE exports SET state='ready',parts_json=?,lease_until=NULL,lease_token=NULL,revision=revision+1 WHERE id=? AND lease_token=? AND state='building'",
    )
      .bind(JSON.stringify(parts), j.id, lease)
      .run();
    if (j.buffer_key) await bucket.delete(j.buffer_key);
    return;
  }
  const nextBuffer = "exports/" + j.id + "/buffer-" + (j.revision + 1);
  await bucket.put(nextBuffer, buffer);
  const r = await env.DB.prepare(
    "UPDATE exports SET file_cursor=?,buffer_key=?,parts_json=?,lease_token=NULL,lease_until=NULL,revision=revision+1 WHERE id=? AND lease_token=? AND state='building' RETURNING id",
  )
    .bind(entry.id, nextBuffer, JSON.stringify(parts), j.id, lease)
    .first();
  if (r && j.buffer_key) await bucket.delete(j.buffer_key);
}
export async function runExportStep(env: Env) {
  if (!env.PHOTOS) return;
  const stamp = now();
  const j = await env.DB.prepare(
    "SELECT * FROM exports WHERE state IN ('planning','building') AND expires_at>? AND (lease_until IS NULL OR lease_until<?) ORDER BY created_at LIMIT 1",
  )
    .bind(stamp, stamp)
    .first<Job>();
  if (!j) return;
  const lease = id(),
    claimed = await env.DB.prepare(
      "UPDATE exports SET lease_token=?,lease_until=? WHERE id=? AND revision=? AND state IN ('planning','building') AND (lease_until IS NULL OR lease_until<?) RETURNING id",
    )
      .bind(lease, stamp + 120000, j.id, j.revision, stamp)
      .first();
  if (!claimed) return;
  if (!(await allowed(env, j))) {
    await env.DB.prepare(
      "UPDATE exports SET state='expired',error_code='access_changed',expires_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",
    )
      .bind(stamp, j.id, lease)
      .run();
    return;
  }
  try {
    if (j.state === "planning") await planStep(env, j, lease);
    else await buildStep(env, j, lease);
  } catch (e) {
    const code =
      e instanceof Error && /^export_[a-z_]+$/.test(e.message)
        ? e.message
        : "export_step_failed";
    // A completed object proves a timed-out multipart completion; a later step reconciles it.
    const completed = await env.PHOTOS.head(key(j));
    if (completed?.size === j.bytes && j.bytes > 0)
      await env.DB.prepare(
        "UPDATE exports SET state='ready',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND state='building'",
      )
        .bind(j.id, lease)
        .run();
    else
      await env.DB.prepare(
        "UPDATE exports SET state='failed',error_code=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND state IN ('planning','building')",
      )
        .bind(code, j.id, lease)
        .run();
  }
}
export async function cleanupExports(env: Env, stamp: number) {
  const [, jobs] = await env.DB.batch<Job>([
    env.DB.prepare(
      "UPDATE exports SET state='expired' WHERE expires_at<=? AND state!='expired'",
    ).bind(stamp),
    env.DB.prepare(
      "SELECT * FROM exports WHERE state IN ('expired','failed') AND (lease_until IS NULL OR lease_until<=?) AND (upload_id IS NOT NULL OR buffer_key IS NOT NULL OR EXISTS(SELECT 1 FROM export_files WHERE job_id=exports.id)) ORDER BY created_at LIMIT 1",
    ).bind(stamp),
  ]);
  if (!env.PHOTOS) return;
  const j = jobs.results[0];
  if (!j) return;
  if (j.upload_id) {
    try {
      await env.PHOTOS.resumeMultipartUpload(key(j), j.upload_id).abort();
    } catch {
      /* completed or already aborted */
    }
  }
  const list = await env.PHOTOS.list({
    prefix: "exports/" + j.id + "/",
    limit: 25,
  });
  if (list.objects.length)
    await env.PHOTOS.delete(list.objects.map((o) => o.key));
  if (!list.truncated) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM export_files WHERE job_id=?").bind(j.id),
      env.DB.prepare(
        "UPDATE exports SET upload_id=NULL,buffer_key=NULL,parts_json=? WHERE id=?",
      ).bind("[]", j.id),
    ]);
  }
}
