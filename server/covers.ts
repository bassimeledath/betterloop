import { Hono } from "hono";
import { z } from "zod";
import type { App, Env } from "./types";
import { member, fail, id, now, rate } from "./security";
import { cleanJpeg } from "./photos";
export const covers = new Hono<App>();
export type Cover = {
  id: string;
  group_id: string;
  data: number[];
  caption: string;
  width: number;
  height: number;
};
export async function getCover(env: Env, gid: string, cid: string) {
  return env.DB.prepare("SELECT * FROM group_covers WHERE id=? AND group_id=?")
    .bind(cid, gid)
    .first<Cover>();
}
export function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
for (const purpose of ["cover", "reminder-image"] as const) {
  const column = purpose === "cover" ? "cover_id" : "reminder_image_id";
  covers.post("/groups/:groupId/" + purpose, async (c) => {
    const gid = c.req.param("groupId")!;
    await member(c, gid, ["owner", "admin"]);
    await rate(c.env, "cover:" + c.get("session").user.id, 12, 3600000);
    if (c.req.header("Content-Type") !== "image/jpeg")
      fail(400, "Choose a JPEG cover.");
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.length > 196608)
      fail(413, "The prepared cover must be under 192 KB.");
    let image;
    try {
      image = cleanJpeg(raw);
    } catch (e) {
      fail(400, (e as Error).message);
    }
    if (image.width !== image.height * 2)
      fail(400, "Crop the cover to a wide 2:1 image.");
    const caption = z
      .string()
      .max(250)
      .parse(
        c.req.header("X-Cover-Caption")
          ? decodeURIComponent(c.req.header("X-Cover-Caption")!)
          : "",
      );
    const cid = id(),
      stamp = now();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO group_covers(id,group_id,data,caption,width,height,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM groups WHERE id=? AND deleted_at IS NULL) AND EXISTS(SELECT 1 FROM memberships WHERE group_id=? AND user_id=? AND active=1 AND role IN ('owner','admin')) AND (SELECT COALESCE(SUM(length(data)),0) FROM group_covers)+?<=67108864 RETURNING id",
      ).bind(
        cid,
        gid,
        image.bytes.buffer,
        caption,
        image.width,
        image.height,
        stamp,
        gid,
        gid,
        c.get("session").user.id,
        image.bytes.length,
      ),
      c.env.DB.prepare(
        `UPDATE groups SET ${column}=?,revision=revision+1 WHERE id=? AND EXISTS(SELECT 1 FROM group_covers WHERE id=?)`,
      ).bind(cid, gid, cid),
    ]);
    if (!results[0].results.length)
      fail(409, "Cover storage is full or this group is unavailable.");
    return c.json({ id: cid }, 201);
  });
  covers.delete("/groups/:groupId/" + purpose, async (c) => {
    const gid = c.req.param("groupId")!;
    await member(c, gid, ["owner", "admin"]);
    const changed = await c.env.DB.prepare(
      `UPDATE groups SET ${column}=NULL,revision=revision+1 WHERE id=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM memberships WHERE group_id=? AND user_id=? AND active=1 AND role IN ('owner','admin')) RETURNING id`,
    )
      .bind(gid, gid, c.get("session").user.id)
      .first();
    if (!changed)
      fail(409, "Your group access changed. Refresh before editing the cover.");
    return c.json({ ok: true });
  });
}
covers.get("/groups/:groupId/covers/:id", async (c) => {
  const gid = c.req.param("groupId")!;
  await member(c, gid);
  const cover = await getCover(c.env, gid, c.req.param("id"));
  if (!cover) fail(404, "Cover not found.");
  return new Response(new Uint8Array(cover.data), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
    },
  });
});
