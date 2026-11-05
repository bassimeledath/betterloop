import { Hono, type Context } from "hono";
import type { App, Env, Issue, Publication, Update } from "./types";
import { id, now, member, fail, rate } from "./security";
import { redactPublication } from "./privacy";
export function cleanJpeg(data: Uint8Array) {
  if (data.length < 12 || data[0] !== 255 || data[1] !== 216)
    throw new Error("Upload a JPEG image.");
  const chunks: Uint8Array[] = [data.slice(0, 2)];
  let p = 2,
    width = 0,
    height = 0,
    finished = false;
  while (p < data.length) {
    const start = p;
    if (data[p++] !== 255) throw new Error("Invalid JPEG structure.");
    while (data[p] === 255) p++;
    const marker = data[p++];
    if (marker === 217) {
      chunks.push(new Uint8Array([255, 217]));
      finished = true;
      break;
    }
    if (marker === 216 || marker === 0 || p + 2 > data.length)
      throw new Error("Invalid JPEG marker.");
    const size = data[p] * 256 + data[p + 1];
    if (size < 2 || p + size > data.length)
      throw new Error("Incomplete image.");
    const end = p + size;
    if (
      [
        192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
      ].includes(marker)
    ) {
      if (size < 8) throw new Error("Invalid image size.");
      height = data[p + 3] * 256 + data[p + 4];
      width = data[p + 5] * 256 + data[p + 6];
      if (width < 1 || height < 1 || width > 1600 || height > 1600)
        throw new Error("Resize your image to 1600 pixels or less.");
    }
    // Strip every application and comment segment, including metadata between scans.
    if (!(marker >= 224 && marker <= 239) && marker !== 254)
      chunks.push(data.slice(start, end));
    p = end;
    if (marker === 218) {
      const scan = p;
      while (p < data.length - 1) {
        if (data[p] === 255) {
          const next = data[p + 1];
          if (next === 0 || (next >= 208 && next <= 215)) {
            p += 2;
            continue;
          }
          if (next === 255) {
            p++;
            continue;
          }
          break;
        }
        p++;
      }
      chunks.push(data.slice(scan, p));
    }
  }
  if (!finished || !width || !height) throw new Error("Incomplete image.");
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, width, height };
}
export async function finishPhotoUpload(
  env: Env,
  aid: string,
  key: string,
  stamp = now(),
) {
  const ready = await env.DB.prepare(
    `UPDATE assets SET state='ready' WHERE id=? AND state='pending'
    AND EXISTS(SELECT 1 FROM groups WHERE id=assets.group_id AND deleted_at IS NULL)
    AND EXISTS(SELECT 1 FROM users WHERE id=assets.user_id AND deleted_at IS NULL)
    AND EXISTS(SELECT 1 FROM memberships WHERE group_id=assets.group_id AND user_id=assets.user_id AND active=1)
    AND EXISTS(SELECT 1 FROM issues WHERE id=assets.issue_id AND group_id=assets.group_id AND state='open' AND deadline>?) RETURNING id`,
  )
    .bind(aid, stamp)
    .first();
  if (ready) return true;
  // A deletion or deadline may have won while the R2 write was in flight.
  // Keep a retryable reservation until the object deletion succeeds.
  await env.DB.prepare(
    "UPDATE assets SET state='deleting' WHERE id=? AND state='pending'",
  )
    .bind(aid)
    .run();
  await env.PHOTOS!.delete(key);
  await env.DB.prepare(
    "DELETE FROM assets WHERE id=? AND state='deleting' AND NOT EXISTS(SELECT 1 FROM export_files WHERE asset_id=assets.id)",
  )
    .bind(aid)
    .run();
  return false;
}
export const photos = new Hono<App>();
photos.post("/groups/:groupId/issues/:issueId/assets", async (c) => {
  const gid = c.req.param("groupId"),
    iid = c.req.param("issueId"),
    user = c.get("session").user.id;
  await member(c, gid);
  const i = await c.env.DB.prepare(
    "SELECT * FROM issues WHERE id=? AND group_id=? AND state='open' AND deadline>?",
  )
    .bind(iid, gid, now())
    .first<Issue>();
  if (!i) fail(409, "Photo uploads close at the issue deadline.");
  if (!c.env.PHOTOS)
    fail(503, "The host needs to configure private photo storage.");
  await rate(c.env, "photo:" + user, 12, 3600000);
  let raw: Uint8Array,
    emailData: ArrayBuffer | null = null;
  if (c.req.header("Content-Type")?.startsWith("multipart/form-data")) {
    const form = await c.req.formData(),
      full = form.get("photo"),
      small = form.get("emailPhoto");
    if (!(full instanceof File) || !(small instanceof File))
      fail(400, "Choose a photo.");
    raw = new Uint8Array(await full.arrayBuffer());
    const bytes = new Uint8Array(await small.arrayBuffer());
    if (bytes.length > 98304) fail(413, "Email photo is too large.");
    try {
      const image = cleanJpeg(bytes);
      if (image.width > 800 || image.height > 800)
        fail(400, "Resize the email photo to 800 pixels.");
      emailData = image.bytes.buffer as ArrayBuffer;
    } catch {
      fail(400, "Invalid email photo.");
    }
  } else if (c.req.header("Content-Type") === "image/jpeg")
    raw = new Uint8Array(await c.req.arrayBuffer());
  else fail(400, "Choose a photo that can be converted to JPEG.");
  if (raw.byteLength > 1048576) fail(413, "Keep each photo under 1 MB.");
  let image;
  let ready = false;
  try {
    image = cleanJpeg(raw);
  } catch (e) {
    fail(400, (e as Error).message);
  }
  const aid = id(),
    key = gid + "/" + iid + "/" + aid + ".jpg",
    stamp = now();
  const reserved = await c.env.DB.prepare(
    `INSERT INTO assets(id,group_id,issue_id,user_id,object_key,content_type,bytes,width,height,state,created_at) SELECT ?,?,?,?,?,'image/jpeg',?,?,?,'pending',? WHERE (SELECT COUNT(*) FROM assets WHERE group_id=? AND issue_id=? AND user_id=? AND state!='deleting')<6 AND (SELECT COALESCE(SUM(bytes),0) FROM assets)+(SELECT COALESCE(SUM(bytes+12582912),0) FROM exports WHERE state IN ('building','ready') AND expires_at>CAST(strftime('%s','now') AS INTEGER)*1000)+?<=5000000000 AND EXISTS(SELECT 1 FROM issues WHERE id=? AND group_id=? AND state='open' AND deadline>?) AND EXISTS(SELECT 1 FROM memberships WHERE group_id=? AND user_id=? AND active=1) RETURNING id`,
  )
    .bind(
      aid,
      gid,
      iid,
      user,
      key,
      image.bytes.byteLength,
      image.width,
      image.height,
      stamp,
      gid,
      iid,
      user,
      image.bytes.byteLength,
      iid,
      gid,
      stamp,
      gid,
      user,
    )
    .first();
  if (!reserved)
    fail(
      409,
      "Your retained photo slots or the app’s storage allowance are full. Remove old photos before adding more.",
    );
  try {
    await c.env.PHOTOS.put(key, image.bytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    ready = await finishPhotoUpload(c.env, aid, key);
  } catch {
    await c.env.DB.prepare("UPDATE assets SET state='deleting' WHERE id=?")
      .bind(aid)
      .run();
    fail(
      503,
      "Photo upload failed. Your written answers are safe; please retry.",
    );
  }
  if (!ready)
    fail(
      409,
      "This issue closed or your group access changed while the photo uploaded.",
    );
  if (emailData)
    await c.env.DB.prepare(
      "UPDATE assets SET email_data=? WHERE id=? AND state='ready' AND (SELECT COALESCE(SUM(length(email_data)),0) FROM assets)+?<=262144000",
    )
      .bind(emailData, aid, emailData.byteLength)
      .run();
  return c.json(
    {
      id: aid,
      width: image.width,
      height: image.height,
      bytes: image.bytes.byteLength,
    },
    201,
  );
});
async function servePhoto(c: Context<App>) {
  const a = await c.env.DB.prepare(
    "SELECT group_id,issue_id,user_id,object_key FROM assets WHERE id=? AND state='ready'",
  )
    .bind(c.req.param("id"))
    .first<{
      group_id: string;
      issue_id: string;
      user_id: string;
      object_key: string;
    }>();
  if (!a) fail(404, "Photo not found.");
  await member(c, a.group_id);
  if (a.user_id !== c.get("session").user.id) {
    const p = await c.env.DB.prepare(
      "SELECT content_json FROM publications WHERE issue_id=? AND group_id=?",
    )
      .bind(a.issue_id, a.group_id)
      .first<{ content_json: string }>();
    if (
      !p ||
      !(
        await redactPublication(c.env, JSON.parse(p.content_json))
      ).contributors.some((person) =>
        person.update.photos.some((x) => x.id === c.req.param("id")),
      )
    )
      fail(404, "Photo not found.");
  }
  if (c.req.path.endsWith("/email")) {
    const compact = await c.env.DB.prepare(
      "SELECT email_data FROM assets WHERE id=?",
    )
      .bind(c.req.param("id"))
      .first<{ email_data: number[] | null }>();
    if (compact?.email_data)
      return new Response(new Uint8Array(compact.email_data), {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "private, no-store",
        },
      });
  }
  const object = await c.env.PHOTOS?.get(a.object_key);
  if (!object) fail(404, "Photo not found.");
  c.header("Cache-Control", "private, no-store");
  c.header("Content-Type", "image/jpeg");
  return new Response(object.body, { headers: c.res.headers });
}
photos.get("/assets/:id", servePhoto);
photos.get("/assets/:id/email", servePhoto);
photos.delete("/assets/:id", async (c) => {
  const aid = c.req.param("id"),
    user = c.get("session").user.id;
  const a = await c.env.DB.prepare(
    "SELECT * FROM assets WHERE id=? AND user_id=?",
  )
    .bind(aid, user)
    .first<{ group_id: string; issue_id: string; object_key: string }>();
  if (!a) fail(404, "Photo not found.");
  await member(c, a.group_id);
  const p = await c.env.DB.prepare(
    "SELECT 1 FROM publications WHERE issue_id=?",
  )
    .bind(a.issue_id)
    .first();
  if (p)
    fail(
      409,
      "Use the contribution deletion flow to remove a published photo.",
    );
  const r = await c.env.DB.prepare(
    "SELECT draft_json,submitted_json FROM contributions WHERE issue_id=? AND user_id=?",
  )
    .bind(a.issue_id, user)
    .first<{ draft_json: string; submitted_json: string | null }>();
  if (
    r &&
    [r.draft_json, r.submitted_json].some(
      (s) => s && (JSON.parse(s) as Update).photos.some((p) => p.id === aid),
    )
  )
    fail(409, "Remove this photo from your draft and submitted update first.");
  await c.env.DB.prepare(
    "UPDATE assets SET state='deleting' WHERE id=? AND NOT EXISTS(SELECT 1 FROM export_files WHERE asset_id=?) AND NOT EXISTS(SELECT 1 FROM contributions c WHERE c.issue_id=assets.issue_id AND (EXISTS(SELECT 1 FROM json_each(c.draft_json,'$.photos') p WHERE json_extract(p.value,'$.id')=assets.id) OR EXISTS(SELECT 1 FROM json_each(c.submitted_json,'$.photos') p WHERE json_extract(p.value,'$.id')=assets.id)))",
  )
    .bind(aid, aid)
    .run();
  return c.json({ ok: true });
});
