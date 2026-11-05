import type { Env, Publication } from "./types";
import { getCover } from "./covers";
export type InlineImage = {
  filename: string;
  type: "image/jpeg";
  disposition: "inline";
  contentId: string;
  content: ArrayBuffer;
};
export async function emailImages(env: Env, gid: string, p: Publication) {
  const sources: Record<string, string> = {},
    attachments: InlineImage[] = [];
  let bytes = 0;
  const add = (id: string, data: Uint8Array) => {
    if (attachments.length >= 32 || bytes + data.length > 12 * 1048576) return;
    bytes += data.length;
    const cid = id + "@betterloop";
    sources[id] = "cid:" + cid;
    attachments.push({
      filename: id + ".jpg",
      type: "image/jpeg",
      disposition: "inline",
      contentId: cid,
      content: data.buffer as ArrayBuffer,
    });
  };
  if (p.coverId) {
    const c = await getCover(env, gid, p.coverId);
    if (c) add(c.id, new Uint8Array(c.data));
  }
  const ids = [
    ...new Set(p.contributors.flatMap((c) => c.update.photos.map((a) => a.id))),
  ];
  if (ids.length) {
    const rows = (
      await env.DB.prepare(
        `SELECT id,object_key,bytes,email_data FROM assets WHERE group_id=? AND state='ready' AND id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(gid, ...ids)
        .all<{
          id: string;
          object_key: string;
          bytes: number;
          email_data: number[] | null;
        }>()
    ).results;
    for (const id of ids) {
      const r = rows.find((r) => r.id === id);
      if (
        !r ||
        attachments.length >= 32 ||
        bytes + (r.email_data?.length || r.bytes) > 12 * 1048576
      )
        continue;
      if (r.email_data) add(id, new Uint8Array(r.email_data));
      else {
        const object = await env.PHOTOS?.get(r.object_key);
        if (object) add(id, new Uint8Array(await object.arrayBuffer()));
      }
    }
  }
  return { sources, attachments };
}
