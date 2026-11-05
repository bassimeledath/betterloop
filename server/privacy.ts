import type { Env, Publication } from "./types";
export async function redactPublication(
  env: Env,
  source: Publication,
): Promise<Publication> {
  const ids = [
    ...new Set([
      ...source.contributors.map((c) => c.id),
      ...source.questions.flatMap((q) => (q.author_id ? [q.author_id] : [])),
    ]),
  ];
  if (!ids.length) return source;
  const deleted = (
    await env.DB.prepare(
      `SELECT id,remove_content FROM users WHERE deleted_at IS NOT NULL AND id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(...ids)
      .all<{ id: string; remove_content: number }>()
  ).results;
  if (!deleted.length) return source;
  return {
    ...source,
    questions: source.questions.map((q) =>
      deleted.some((d) => d.id === q.author_id)
        ? { ...q, author_name: "Former member" }
        : q,
    ),
    contributors: source.contributors
      .filter((p) => !deleted.some((d) => d.id === p.id && d.remove_content))
      .map((p) =>
        deleted.some((d) => d.id === p.id)
          ? { ...p, name: "Former member" }
          : p,
      ),
  };
}
export async function invalidateExports(
  env: Env,
  userId: string,
  stamp: number,
) {
  // Any archive built before a deletion may contain copies of the removed content.
  await env.DB.prepare(
    "UPDATE exports SET state='expired',expires_at=?,error_code='privacy_changed' WHERE user_id=? OR group_id IN (SELECT group_id FROM memberships WHERE user_id=?)",
  )
    .bind(stamp, userId, userId)
    .run();
}
