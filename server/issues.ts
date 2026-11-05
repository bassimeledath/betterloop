import { Hono } from "hono";
import { z } from "zod";
import type { App, Issue, Contribution, Update } from "./types";
import { id, now, member, fail, audit } from "./security";
import { offsets, reminderTime } from "./reminders";
import { redactPublication } from "./privacy";
export const issues = new Hono<App>();
export const emptyUpdate: Update = {
  answers: {},
  photos: [],
  shoutout: "",
  good: "",
};
const updateSchema = z.object({
  answers: z.record(z.string(), z.string().max(10000)),
  photos: z
    .array(z.object({ id: z.uuid(), caption: z.string().max(250) }))
    .max(3),
  shoutout: z.string().max(10000),
  good: z.string().max(10000),
});
async function load(c: Parameters<typeof member>[0], gid: string, iid: string) {
  await member(c, gid);
  const i = await c.env.DB.prepare(
    "SELECT i.*,g.timezone FROM issues i JOIN groups g ON g.id=i.group_id WHERE i.id=? AND i.group_id=?",
  )
    .bind(iid, gid)
    .first<Issue & { timezone: string }>();
  if (!i) fail(404, "Issue not found.");
  return i;
}
function writable(i: Issue) {
  if (i.state !== "open" || i.deadline <= now())
    fail(
      409,
      "This issue has closed. Your text is still here, but new submissions are no longer accepted.",
    );
}
export async function validateUpdate(
  c: Parameters<typeof member>[0],
  gid: string,
  iid: string,
  input: unknown,
) {
  const u = updateSchema.parse(input);
  const fields = [
      ...Object.values(u.answers),
      u.shoutout,
      u.good,
      ...u.photos.map((p) => p.caption),
    ],
    text = fields.join("\n"),
    encoded = new TextEncoder().encode(text);
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(encoded) !== text
  )
    fail(
      400,
      "Use valid text without hidden control characters in your answers and captions.",
    );
  // Separators prevent malformed surrogate halves in different fields from pairing.
  if (encoded.byteLength - (fields.length - 1) > 10000)
    fail(413, "Keep your answers and captions under 10 KB in total.");
  const q = (
    await c.env.DB.prepare(
      "SELECT id FROM issue_questions WHERE issue_id=? AND group_id=?",
    )
      .bind(iid, gid)
      .all<{ id: string }>()
  ).results;
  if (Object.keys(u.answers).some((key) => !q.some((x) => x.id === key)))
    fail(400, "These answers contain a question from another issue.");
  if (new Set(u.photos.map((p) => p.id)).size !== u.photos.length)
    fail(400, "A photo can only appear once.");
  for (const p of u.photos) {
    const asset = await c.env.DB.prepare(
      "SELECT id FROM assets WHERE id=? AND group_id=? AND issue_id=? AND user_id=? AND state='ready'",
    )
      .bind(p.id, gid, iid, c.get("session").user.id)
      .first();
    if (!asset)
      fail(400, "A photo is unavailable or belongs to a different update.");
  }
  return u;
}
issues.get("/:groupId/issues", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid);
  const cursor = Number(c.req.query("before") || Number.MAX_SAFE_INTEGER);
  const rows = await c.env.DB.prepare(
    "SELECT id,title,state,delivery_at,deadline,opens_at FROM issues WHERE group_id=? AND delivery_at<? ORDER BY delivery_at DESC LIMIT 25",
  )
    .bind(gid, cursor)
    .all();
  return c.json({ issues: rows.results });
});
issues.post("/:groupId/issues", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner", "admin"]);
  const b = z
    .object({
      title: z.string().trim().min(1).max(120),
      deliveryAt: z.number().int(),
      requestId: z.uuid().optional(),
    })
    .parse(await c.req.json());
  const creationKey = b.requestId
    ? c.get("session").user.id + ":" + gid + ":" + b.requestId
    : null;
  const replay = async () =>
    creationKey
      ? await c.env.DB.prepare(
          "SELECT id FROM issues WHERE creation_key=? AND group_id=?",
        )
          .bind(creationKey, gid)
          .first<{ id: string }>()
      : null;
  const prior = await replay();
  if (prior) return c.json({ id: prior.id });
  if (b.deliveryAt <= now() + 60000)
    fail(400, "Choose a delivery at least one minute in the future.");
  const existing = await c.env.DB.prepare(
    "SELECT id FROM issues WHERE group_id=? AND state IN ('scheduled','open','closing')",
  )
    .bind(gid)
    .first();
  if (existing) {
    const created = await replay();
    if (created) return c.json({ id: created.id });
    fail(409, "Finish or cancel the current issue before starting another.");
  }
  const qs = (
    await c.env.DB.prepare(
      "SELECT q.text,q.position,q.author_id,u.name AS author_name FROM questions q LEFT JOIN users u ON u.id=q.author_id WHERE group_id=? AND selected=1 ORDER BY q.position,q.created_at LIMIT 10",
    )
      .bind(gid)
      .all<{
        text: string;
        position: number;
        author_id: string | null;
        author_name: string;
      }>()
  ).results;
  if (!qs.length)
    fail(400, "Choose at least one question before opening an issue.");
  const policy = await c.env.DB.prepare(
    "SELECT reminder_offsets_json FROM groups WHERE id=?",
  )
    .bind(gid)
    .first<{ reminder_offsets_json: string }>();
  const iid = id(),
    stamp = now();
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO issues(id,group_id,title,opens_at,deadline,delivery_at,state,reminder_at,created_at,creation_key,reminder_offsets_json) SELECT ?,?,?,?,?,?,'open',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM issues WHERE group_id=? AND state IN ('scheduled','open','closing')) RETURNING id",
    ).bind(
      iid,
      gid,
      b.title,
      stamp,
      b.deliveryAt,
      b.deliveryAt,
      reminderTime(b.deliveryAt, offsets(policy?.reminder_offsets_json)[0]),
      stamp,
      creationKey,
      policy?.reminder_offsets_json || "[48]",
      gid,
    ),
    ...qs.map((q, j) =>
      c.env.DB.prepare(
        "INSERT INTO issue_questions(id,issue_id,group_id,text,author_name,position,author_id) SELECT ?,id,?,?,?,?,? FROM issues WHERE id=?",
      ).bind(
        id(),
        gid,
        q.text,
        q.author_name || "The group",
        j,
        q.author_id || null,
        iid,
      ),
    ),
    c.env.DB.prepare(
      "INSERT INTO audit_events(id,actor_id,group_id,action,target,created_at) SELECT ?,?,group_id,'issue.opened',id,? FROM issues WHERE id=?",
    ).bind(id(), c.get("session").user.id, stamp, iid),
  ]);
  if (!result[0].results.length) {
    const created = await replay();
    if (created) return c.json({ id: created.id });
    fail(
      409,
      "Another issue was opened or this delivery time is already used. Refresh or choose a different deadline.",
    );
  }
  return c.json({ id: iid }, 201);
});
issues.get("/:groupId/issues/:issueId", async (c) => {
  const gid = c.req.param("groupId"),
    iid = c.req.param("issueId"),
    issue = await load(c, gid, iid);
  const questions = (
    await c.env.DB.prepare(
      "SELECT q.id,q.issue_id,q.group_id,q.text,q.position,q.author_id,CASE WHEN u.deleted_at IS NOT NULL THEN 'Former member' ELSE q.author_name END AS author_name FROM issue_questions q LEFT JOIN users u ON u.id=q.author_id WHERE q.issue_id=? AND q.group_id=? ORDER BY q.position",
    )
      .bind(iid, gid)
      .all()
  ).results;
  const contribution = await c.env.DB.prepare(
    "SELECT * FROM contributions WHERE issue_id=? AND group_id=? AND user_id=?",
  )
    .bind(iid, gid, c.get("session").user.id)
    .first<Contribution>();
  const publication = await c.env.DB.prepare(
    "SELECT content_json,published_at FROM publications WHERE issue_id=? AND group_id=?",
  )
    .bind(iid, gid)
    .first<{ content_json: string; published_at: number }>();
  return c.json({
    issue,
    questions,
    contribution: contribution
      ? {
          draft: JSON.parse(contribution.draft_json),
          submitted: contribution.submitted_json
            ? JSON.parse(contribution.submitted_json)
            : null,
          revision: contribution.revision,
          submittedAt: contribution.submitted_at,
        }
      : null,
    publication: publication
      ? await redactPublication(c.env, JSON.parse(publication.content_json))
      : null,
  });
});
issues.put("/:groupId/issues/:issueId/contribution", async (c) => {
  const gid = c.req.param("groupId"),
    iid = c.req.param("issueId");
  writable(await load(c, gid, iid));
  const b = z
    .object({ revision: z.number().int().nonnegative(), update: z.unknown() })
    .parse(await c.req.json());
  const u = await validateUpdate(c, gid, iid, b.update),
    stamp = now(),
    user = c.get("session").user.id;
  const r = await c.env.DB.prepare(
    `INSERT INTO contributions(issue_id,group_id,user_id,draft_json,revision,updated_at) SELECT ?,?,?,?,1,? WHERE ?=0 AND EXISTS(SELECT 1 FROM issues WHERE id=? AND group_id=? AND state='open' AND deadline>?) AND EXISTS(SELECT 1 FROM memberships WHERE group_id=? AND user_id=? AND active=1) ON CONFLICT(issue_id,user_id) DO UPDATE SET draft_json=excluded.draft_json,revision=contributions.revision+1,updated_at=excluded.updated_at WHERE contributions.revision=? AND EXISTS(SELECT 1 FROM issues WHERE id=? AND group_id=? AND state='open' AND deadline>?) RETURNING revision`,
  )
    .bind(
      iid,
      gid,
      user,
      JSON.stringify(u),
      stamp,
      b.revision,
      iid,
      gid,
      stamp,
      gid,
      user,
      b.revision,
      iid,
      gid,
      stamp,
    )
    .first<{ revision: number }>();
  // An UPDATE path needs a source row even for a nonzero revision. Handle it directly.
  if (!r && b.revision > 0) {
    const updated = await c.env.DB.prepare(
      `UPDATE contributions SET draft_json=?,revision=revision+1,updated_at=? WHERE issue_id=? AND group_id=? AND user_id=? AND revision=? AND EXISTS(SELECT 1 FROM issues WHERE id=? AND group_id=? AND state='open' AND deadline>?) AND EXISTS(SELECT 1 FROM memberships WHERE group_id=? AND user_id=? AND active=1) RETURNING revision`,
    )
      .bind(
        JSON.stringify(u),
        stamp,
        iid,
        gid,
        user,
        b.revision,
        iid,
        gid,
        stamp,
        gid,
        user,
      )
      .first<{ revision: number }>();
    if (updated) return c.json(updated);
  }
  if (!r)
    fail(
      409,
      "This draft changed in another tab or the issue closed. Keep your text and reload the saved version before retrying.",
    );
  return c.json(r);
});
issues.post("/:groupId/issues/:issueId/submit", async (c) => {
  const gid = c.req.param("groupId"),
    iid = c.req.param("issueId");
  writable(await load(c, gid, iid));
  const b = z
      .object({ revision: z.number().int().positive() })
      .parse(await c.req.json()),
    user = c.get("session").user.id;
  const record = await c.env.DB.prepare(
    "SELECT * FROM contributions WHERE issue_id=? AND group_id=? AND user_id=? AND revision=?",
  )
    .bind(iid, gid, user, b.revision)
    .first<Contribution>();
  if (!record) fail(409, "Save the current version before submitting.");
  const u = await validateUpdate(c, gid, iid, JSON.parse(record.draft_json));
  if (
    !Object.values(u.answers).some((s) => s.trim()) &&
    !u.good.trim() &&
    !u.shoutout.trim() &&
    !u.photos.length
  )
    fail(400, "Share an answer, a photo, or one good thing before submitting.");
  const stamp = now(),
    r = await c.env.DB.prepare(
      "UPDATE contributions SET submitted_json=draft_json,submitted_at=?,revision=revision+1 WHERE issue_id=? AND group_id=? AND user_id=? AND revision=? AND EXISTS(SELECT 1 FROM issues WHERE id=? AND group_id=? AND state='open' AND deadline>?) AND EXISTS(SELECT 1 FROM memberships WHERE group_id=? AND user_id=? AND active=1) RETURNING revision",
    )
      .bind(stamp, iid, gid, user, b.revision, iid, gid, stamp, gid, user)
      .first<{ revision: number }>();
  if (!r)
    fail(
      409,
      "The update changed or the issue closed. Refresh before submitting again.",
    );
  return c.json({ ...r, submittedAt: stamp });
});
issues.post("/:groupId/issues/:issueId/withdraw", async (c) => {
  const gid = c.req.param("groupId"),
    iid = c.req.param("issueId");
  writable(await load(c, gid, iid));
  const b = z
      .object({ revision: z.number().int().positive() })
      .parse(await c.req.json()),
    stamp = now();
  const r = await c.env.DB.prepare(
    "UPDATE contributions SET submitted_json=NULL,submitted_at=NULL,revision=revision+1 WHERE issue_id=? AND group_id=? AND user_id=? AND revision=? AND EXISTS(SELECT 1 FROM issues WHERE id=? AND group_id=? AND state='open' AND deadline>?) RETURNING revision",
  )
    .bind(iid, gid, c.get("session").user.id, b.revision, iid, gid, stamp)
    .first();
  if (!r) fail(409, "The update changed or the issue closed.");
  return c.json(r);
});
issues.patch("/:groupId/issues/:issueId", async (c) => {
  const gid = c.req.param("groupId"),
    iid = c.req.param("issueId");
  await member(c, gid, ["owner", "admin"]);
  const issue = await load(c, gid, iid);
  const b = z
    .object({
      action: z.enum(["extend", "cancel"]),
      deadline: z.number().int().optional(),
    })
    .parse(await c.req.json());
  if (!["scheduled", "open"].includes(issue.state))
    fail(409, "This issue cannot be changed now.");
  const stamp = now();
  if (b.action === "extend") {
    if (!b.deadline || b.deadline <= Math.max(stamp, issue.deadline))
      fail(400, "Choose a deadline later than the current deadline.");
    const r = await c.env.DB.prepare(
      "UPDATE issues SET deadline=?,delivery_at=?,reminder_at=?,reminded_at=NULL,reminder_index=0,revision=revision+1 WHERE id=? AND group_id=? AND state IN ('scheduled','open') RETURNING id",
    )
      .bind(
        b.deadline,
        b.deadline,
        reminderTime(b.deadline, offsets(issue.reminder_offsets_json)[0]),
        iid,
        gid,
      )
      .first();
    if (!r) fail(409, "This issue has already closed.");
  } else
    await c.env.DB.prepare(
      "UPDATE issues SET state='cancelled',cancelled_at=unixepoch('subsec')*1000,revision=revision+1 WHERE id=? AND group_id=? AND state IN ('scheduled','open')",
    )
      .bind(iid, gid)
      .run();
  await c.env.DB.prepare(
    "UPDATE email_outbox SET state='skipped',error_code='issue_changed',updated_at=? WHERE issue_id=? AND kind IN ('opening','reminder') AND state='queued'",
  )
    .bind(stamp, iid)
    .run();
  await audit(c.env, c.get("session").user.id, gid, "issue." + b.action, iid);
  return c.json({ ok: true });
});
issues.get("/:groupId/issues/:issueId/delivery", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner", "admin"]);
  const r = await c.env.DB.prepare(
    "SELECT o.id,u.name,o.kind,o.state,o.attempts,o.error_code,o.updated_at FROM email_outbox o JOIN users u ON u.id=o.user_id WHERE o.group_id=? AND o.issue_id=? ORDER BY o.created_at",
  )
    .bind(gid, c.req.param("issueId"))
    .all();
  return c.json({ messages: r.results });
});
