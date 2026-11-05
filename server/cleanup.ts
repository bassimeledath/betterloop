import type { Env, Publication } from "./types";
import { redactPublication } from "./privacy";
import { cleanupExports } from "./exports";
const DAY = 86400000;
export async function runCleanup(env: Env, stamp = Date.now()) {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM join_signups WHERE expires_at<? OR joined_at<?",
    ).bind(stamp, stamp - DAY),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(stamp),
    env.DB.prepare("DELETE FROM login_tokens WHERE expires_at<?").bind(
      stamp - DAY,
    ),
    env.DB.prepare("DELETE FROM email_changes WHERE expires_at<?").bind(
      stamp - DAY,
    ),
    env.DB.prepare("DELETE FROM captured_emails WHERE created_at<?").bind(
      stamp - 7 * DAY,
    ),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start<?").bind(
      stamp - DAY,
    ),
    env.DB.prepare("DELETE FROM audit_events WHERE created_at<?").bind(
      stamp - 30 * DAY,
    ),
    env.DB.prepare(
      "UPDATE email_outbox SET state='skipped',payload=NULL,error_code='expired',updated_at=? WHERE state='queued' AND expires_at<?",
    ).bind(stamp, stamp),
    env.DB.prepare(
      "UPDATE email_outbox SET payload=NULL WHERE expires_at<?",
    ).bind(stamp),
    env.DB.prepare(
      "DELETE FROM contributions WHERE issue_id IN (SELECT id FROM issues WHERE state=? AND cancelled_at<?)",
    ).bind("cancelled", stamp - 30 * DAY),
  ]);
  // Revoke exports tied to a deleted group before releasing their source photos.
  await env.DB.prepare(
    "UPDATE exports SET state='expired',expires_at=?,error_code='group_deleted' WHERE state!='expired' AND (group_id IN (SELECT id FROM groups WHERE deleted_at IS NOT NULL) OR id IN (SELECT f.job_id FROM export_files f JOIN assets a ON a.id=f.asset_id JOIN groups g ON g.id=a.group_id WHERE g.deleted_at IS NOT NULL))",
  )
    .bind(stamp)
    .run();
  await cleanupExports(env, stamp);
  const deletion = await env.DB.prepare(
    "SELECT * FROM deletion_records WHERE user_id IS NOT NULL AND completed_at IS NULL ORDER BY created_at LIMIT 1",
  ).first<{ id: string; user_id: string; cursor: string }>();
  if (deletion) {
    const row = await env.DB.prepare(
      "SELECT p.issue_id,p.content_json FROM publications p WHERE p.issue_id>? AND (EXISTS(SELECT 1 FROM json_each(p.content_json,'$.contributors') c WHERE json_extract(c.value,'$.id')=?) OR EXISTS(SELECT 1 FROM json_each(p.content_json,'$.questions') q WHERE json_extract(q.value,'$.author_id')=?)) ORDER BY p.issue_id LIMIT 1",
    )
      .bind(deletion.cursor, deletion.user_id, deletion.user_id)
      .first<{ issue_id: string; content_json: string }>();
    if (row) {
      const clean = await redactPublication(
        env,
        JSON.parse(row.content_json) as Publication,
      );
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE publications SET content_json=?,version=version+1 WHERE issue_id=?",
        ).bind(JSON.stringify(clean), row.issue_id),
        env.DB.prepare("UPDATE deletion_records SET cursor=? WHERE id=?").bind(
          row.issue_id,
          deletion.id,
        ),
      ]);
    } else
      await env.DB.prepare(
        "UPDATE deletion_records SET completed_at=? WHERE id=?",
      )
        .bind(stamp, deletion.id)
        .run();
  }
  if (env.PHOTOS) {
    const photos = await env.DB.prepare(
      `UPDATE assets SET state='deleting' WHERE id IN (SELECT a.id FROM assets a JOIN groups g ON g.id=a.group_id JOIN users u ON u.id=a.user_id
   WHERE NOT EXISTS(SELECT 1 FROM export_files WHERE asset_id=a.id) AND (
    a.state='deleting' OR ((a.state!='pending' OR a.created_at<?) AND (g.deleted_at IS NOT NULL OR (u.deleted_at IS NOT NULL AND u.remove_content=1))) OR
    (a.created_at<? AND NOT EXISTS(SELECT 1 FROM contributions c WHERE c.issue_id=a.issue_id AND (EXISTS(SELECT 1 FROM json_each(c.draft_json,'$.photos') p WHERE json_extract(p.value,'$.id')=a.id) OR EXISTS(SELECT 1 FROM json_each(c.submitted_json,'$.photos') p WHERE json_extract(p.value,'$.id')=a.id))) AND NOT EXISTS(SELECT 1 FROM publications p,json_tree(p.content_json) j WHERE p.issue_id=a.issue_id AND j.key='id' AND j.value=a.id))
   ) ORDER BY a.created_at LIMIT 25) RETURNING id,object_key`,
    )
      .bind(stamp - DAY, stamp - DAY)
      .all<{ id: string; object_key: string }>();
    if (photos.results.length) {
      await env.PHOTOS.delete(photos.results.map((p) => p.object_key));
      const marks = photos.results.map(() => "?").join(",");
      await env.DB.prepare(
        `DELETE FROM assets WHERE id IN (${marks}) AND state='deleting' AND NOT EXISTS(SELECT 1 FROM export_files WHERE asset_id=assets.id)`,
      )
        .bind(...photos.results.map((p) => p.id))
        .run();
    }
  }
  // Purge content from the first cleanup tick, retaining the empty tombstone for
  // retries until day 29. Bounded batches leave room for retries before day 30.
  const group = await env.DB.prepare(
    `SELECT g.id,g.deleted_at FROM groups g WHERE g.deleted_at IS NOT NULL AND (
      g.deleted_at<? OR EXISTS(SELECT 1 FROM issues WHERE group_id=g.id) OR
      EXISTS(SELECT 1 FROM assets WHERE group_id=g.id) OR
      EXISTS(SELECT 1 FROM exports WHERE group_id=g.id AND (upload_id IS NOT NULL OR buffer_key IS NOT NULL OR EXISTS(SELECT 1 FROM export_files WHERE job_id=exports.id)))
    ) ORDER BY g.deleted_at LIMIT 1`,
  )
    .bind(stamp - 29 * DAY)
    .first<{ id: string; deleted_at: number }>();
  if (!group) return;
  if (
    await env.DB.prepare("SELECT id FROM assets WHERE group_id=? LIMIT 1")
      .bind(group.id)
      .first()
  )
    return;
  const issues = await env.DB.prepare(
    "SELECT id FROM issues WHERE group_id=? LIMIT 25",
  )
    .bind(group.id)
    .all<{ id: string }>();
  if (issues.results.length) {
    const ids = issues.results.map((i) => i.id),
      marks = ids.map(() => "?").join(",");
    await env.DB.batch([
      ...[
        "contributions",
        "publications",
        "issue_questions",
        "email_outbox",
      ].map((table) =>
        env.DB.prepare(
          `DELETE FROM ${table} WHERE issue_id IN (${marks})`,
        ).bind(...ids),
      ),
      env.DB.prepare(`DELETE FROM service_state WHERE key IN (${marks})`).bind(
        ...ids.map((i) => "opened:" + i),
      ),
      env.DB.prepare(`DELETE FROM issues WHERE id IN (${marks})`).bind(...ids),
    ]);
    return;
  }
  if (group.deleted_at >= stamp - 29 * DAY) return;
  // Export cleanup must finish first: removing its records earlier would lose
  // the only durable reference to private archive objects or multipart uploads.
  if (
    await env.DB.prepare(
      "SELECT id FROM exports WHERE group_id=? AND (upload_id IS NOT NULL OR buffer_key IS NOT NULL OR parts_json!='[]' OR EXISTS(SELECT 1 FROM export_files WHERE job_id=exports.id)) LIMIT 1",
    )
      .bind(group.id)
      .first()
  )
    return;
  // Sweep any abandoned upload objects before removing the final group record.
  if (env.PHOTOS) {
    const remaining = await env.PHOTOS.list({
      prefix: group.id + "/",
      limit: 25,
    });
    if (remaining.objects.length)
      await env.PHOTOS.delete(remaining.objects.map((o) => o.key));
    if (remaining.truncated) return;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM exports WHERE group_id=?").bind(group.id),
    env.DB.prepare("DELETE FROM memberships WHERE group_id=?").bind(group.id),
    env.DB.prepare("DELETE FROM invitations WHERE group_id=?").bind(group.id),
    env.DB.prepare("DELETE FROM questions WHERE group_id=?").bind(group.id),
    env.DB.prepare("DELETE FROM transfers WHERE group_id=?").bind(group.id),
    env.DB.prepare("DELETE FROM email_outbox WHERE group_id=?").bind(group.id),
    env.DB.prepare("DELETE FROM groups WHERE id=?").bind(group.id),
  ]);
}
