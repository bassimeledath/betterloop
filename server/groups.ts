import { Hono } from "hono";
import { z } from "zod";
import type { App, Group, Member, User } from "./types";
import {
  id,
  token,
  hash,
  now,
  member,
  operator,
  fail,
  audit,
  normalizeEmail,
  authenticate,
} from "./security";
import { validTimezone } from "../shared/timezone";
import { sharedLinkControls } from "./shared-join";
export const groups = new Hono<App>();
groups.route("/:groupId/join-link", sharedLinkControls);
const recurrence = z.object({
  day: z.number().int().min(1).max(31),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  weekday: z.number().int().min(1).max(7),
});
const settings = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500),
  timezone: z.string().refine(validTimezone, "Choose a valid timezone."),
  cadence: z.enum(["weekly", "fortnightly", "monthly"]),
  recurrence,
});
const creation = settings.extend({ requestId: z.uuid().optional() });
const seedQuestions = [
  "What has been a small bright spot lately?",
  "What are you looking forward to?",
  "What’s something you’d love us to do together?",
];
groups.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT g.*,m.role,
  (SELECT COUNT(*) FROM memberships x WHERE x.group_id=g.id AND x.active=1) AS member_count,
  (SELECT COUNT(*) FROM publications p WHERE p.group_id=g.id) AS publication_count,
  (SELECT i.id FROM issues i WHERE i.group_id=g.id AND i.state='open' AND i.deadline>? LIMIT 1) AS active_issue,
  (SELECT c.submitted_at FROM contributions c JOIN issues i ON i.id=c.issue_id WHERE c.group_id=g.id AND c.user_id=m.user_id AND i.state='open' AND i.deadline>? LIMIT 1) AS submitted_at
  FROM groups g JOIN memberships m ON m.group_id=g.id WHERE m.user_id=? AND m.active=1 AND g.deleted_at IS NULL ORDER BY g.created_at DESC`,
  )
    .bind(now(), now(), c.get("session").user.id)
    .all();
  return c.json({ groups: rows.results });
});
groups.post("/", async (c) => {
  const b = creation.parse(await c.req.json());
  const user = c.get("session").user,
    stamp = now(),
    gid = id();
  const creationKey = b.requestId ? user.id + ":" + b.requestId : null;
  const replay = async () => {
    if (!creationKey) return null;
    const prior = await c.env.DB.prepare(
      "SELECT id,deleted_at FROM groups WHERE creation_key=? AND owner_id=?",
    )
      .bind(creationKey, user.id)
      .first<{ id: string; deleted_at: number | null }>();
    if (prior?.deleted_at != null)
      fail(
        409,
        "That group was deleted. Open a fresh create-group form to start another.",
      );
    return prior?.id || null;
  };
  const prior = await replay();
  if (prior) return c.json({ id: prior });
  const { nextDelivery } = await import("../shared/schedule");
  const delivery = nextDelivery(stamp, b.timezone, b.cadence, b.recurrence);
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO groups(id,name,description,owner_id,timezone,cadence,recurrence_json,next_delivery,created_at,creation_key) SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM groups WHERE owner_id=? AND deleted_at IS NULL)<(SELECT group_allowance FROM users WHERE id=? AND deleted_at IS NULL) AND (SELECT COUNT(*) FROM groups WHERE deleted_at IS NULL)<5 RETURNING id`,
    ).bind(
      gid,
      b.name,
      b.description,
      user.id,
      b.timezone,
      b.cadence,
      JSON.stringify(b.recurrence),
      delivery,
      stamp,
      creationKey,
      user.id,
      user.id,
    ),
    c.env.DB.prepare(
      `INSERT INTO memberships(group_id,user_id,role,joined_at) SELECT id,?,'owner',? FROM groups WHERE id=? AND owner_id=?`,
    ).bind(user.id, stamp, gid, user.id),
    ...seedQuestions.map((text, i) =>
      c.env.DB.prepare(
        "INSERT INTO questions(id,group_id,author_id,text,selected,position,created_at) SELECT ?,id,?,?,1,?,? FROM groups WHERE id=? AND owner_id=?",
      ).bind(id(), user.id, text, i, stamp, gid, user.id),
    ),
    c.env.DB.prepare(
      "INSERT INTO audit_events(id,actor_id,group_id,action,target,created_at) SELECT ?,?,id,'group.created',id,? FROM groups WHERE id=? AND owner_id=?",
    ).bind(id(), user.id, stamp, gid, user.id),
  ]);
  if (!result[0].results.length) {
    const created = await replay();
    if (created) return c.json({ id: created });
    fail(403, "Your host needs to enable more group capacity.");
  }
  return c.json({ id: gid }, 201);
});
groups.get("/:groupId", async (c) => {
  const gid = c.req.param("groupId"),
    m = await member(c, gid);
  const g = await c.env.DB.prepare(
    "SELECT g.*,(SELECT caption FROM group_covers WHERE id=g.cover_id) AS cover_caption,(SELECT COUNT(*) FROM questions q WHERE q.group_id=g.id AND q.selected=1) AS selected_questions FROM groups g WHERE g.id=?",
  )
    .bind(gid)
    .first<Group>();
  const people = await c.env.DB.prepare(
    "SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON m.user_id=u.id WHERE m.group_id=? AND m.active=1 ORDER BY m.joined_at",
  )
    .bind(gid)
    .all();
  const issues = await c.env.DB.prepare(
    `SELECT i.*,(SELECT COUNT(*) FROM contributions x JOIN memberships a ON a.user_id=x.user_id AND a.group_id=x.group_id AND a.active=1 WHERE x.issue_id=i.id AND x.submitted_json IS NOT NULL) AS submitted_count,(SELECT submitted_at FROM contributions x WHERE x.issue_id=i.id AND x.user_id=?) AS my_submitted_at FROM issues i WHERE group_id=? ORDER BY delivery_at DESC LIMIT 25`,
  )
    .bind(c.get("session").user.id, gid)
    .all();
  const empty = await c.env.DB.prepare(
    "SELECT COUNT(*) n FROM issues WHERE group_id=? AND state='skipped' AND delivery_at>COALESCE((SELECT MAX(delivery_at) FROM issues WHERE group_id=? AND state='published'),0)",
  )
    .bind(gid, gid)
    .first<{ n: number }>();
  return c.json({
    group: g,
    membership: m,
    members: people.results,
    issues: issues.results,
    emptyIssues: empty!.n,
  });
});
groups.get("/:groupId/archive", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid);
  const before = c.req.query("before");
  let cursor: { delivery_at: number; id: string } | null = null;
  if (before) {
    cursor = await c.env.DB.prepare(
      "SELECT id,delivery_at FROM issues WHERE id=? AND group_id=? AND state='published'",
    )
      .bind(before, gid)
      .first();
    if (!cursor) fail(400, "This archive cursor is no longer available.");
  }
  const rows = (
    await c.env.DB.prepare(
      "SELECT id,title,delivery_at FROM issues WHERE group_id=? AND state='published' AND (? IS NULL OR (delivery_at,id)<(?,?)) ORDER BY delivery_at DESC,id DESC LIMIT 21",
    )
      .bind(gid, cursor?.id ?? null, cursor?.delivery_at ?? 0, cursor?.id ?? "")
      .all<{ id: string; title: string; delivery_at: number }>()
  ).results;
  return c.json({
    issues: rows.slice(0, 20),
    next: rows.length > 20 ? rows[19].id : null,
  });
});
groups.patch("/:groupId", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner", "admin"]);
  const b = settings
    .extend({ revision: z.number().int().nonnegative() })
    .parse(await c.req.json());
  const { nextDelivery } = await import("../shared/schedule");
  const next = nextDelivery(now(), b.timezone, b.cadence, b.recurrence);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE issues SET state='cancelled',cancelled_at=?,revision=revision+1 WHERE group_id=? AND state='scheduled' AND EXISTS(SELECT 1 FROM groups WHERE id=? AND revision=?)",
    ).bind(now(), gid, gid, b.revision),
    c.env.DB.prepare(
      "UPDATE groups SET name=?,description=?,timezone=?,cadence=?,recurrence_json=?,next_delivery=?,revision=revision+1 WHERE id=? AND revision=? RETURNING revision",
    ).bind(
      b.name,
      b.description,
      b.timezone,
      b.cadence,
      JSON.stringify(b.recurrence),
      next,
      gid,
      b.revision,
    ),
  ]);
  const r = results[1].results[0];
  if (!r) fail(409, "The group settings changed. Refresh before saving again.");
  await audit(c.env, c.get("session").user.id, gid, "group.settings");
  return c.json(r);
});
groups.post("/:groupId/schedule-preview", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner", "admin"]);
  const b = settings.parse(await c.req.json());
  const { nextDelivery } = await import("../shared/schedule");
  const delivery = nextDelivery(now(), b.timezone, b.cadence, b.recurrence);
  return c.json({ delivery, opensAt: delivery - 7 * 86400000 });
});
groups.post("/:groupId/pause", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner", "admin"]);
  const b = z
    .object({
      paused: z.boolean(),
      current: z.enum(["finish", "cancel"]).default("finish"),
    })
    .parse(await c.req.json());
  const stamp = now();
  const g = (await c.env.DB.prepare("SELECT * FROM groups WHERE id=?")
    .bind(gid)
    .first<Group>())!;
  const { nextDelivery } = await import("../shared/schedule");
  const next = nextDelivery(
    stamp,
    g.timezone,
    g.cadence,
    JSON.parse(g.recurrence_json),
  );
  const statements = [
    c.env.DB.prepare(
      "UPDATE groups SET paused=?,next_delivery=?,revision=revision+1 WHERE id=?",
    ).bind(+b.paused, next, gid),
  ];
  if (b.paused) {
    statements.push(
      c.env.DB.prepare(
        "UPDATE issues SET state='cancelled',cancelled_at=unixepoch('subsec')*1000,revision=revision+1 WHERE group_id=? AND state='scheduled'",
      ).bind(gid),
    );
    statements.push(
      c.env.DB.prepare(
        "UPDATE email_outbox SET state='skipped',payload=NULL,error_code='group_paused',updated_at=? WHERE group_id=? AND kind IN ('opening','reminder') AND state='queued'",
      ).bind(stamp, gid),
    );
    if (b.current === "cancel")
      statements.push(
        c.env.DB.prepare(
          "UPDATE issues SET state='cancelled',cancelled_at=unixepoch('subsec')*1000,revision=revision+1 WHERE group_id=? AND state='open'",
        ).bind(gid),
      );
  }
  await c.env.DB.batch(statements);
  await audit(
    c.env,
    c.get("session").user.id,
    gid,
    b.paused ? "group.paused" : "group.resumed",
  );
  return c.json({ ok: true });
});
groups.get("/:groupId/questions", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid);
  const r = await c.env.DB.prepare(
    "SELECT q.*,u.name AS author_name FROM questions q LEFT JOIN users u ON u.id=q.author_id WHERE group_id=? ORDER BY q.selected DESC,q.position,q.created_at",
  )
    .bind(gid)
    .all();
  return c.json({ questions: r.results, starter: seedQuestions });
});
groups.post("/:groupId/questions", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid);
  const b = z
    .object({ text: z.string().trim().min(3).max(500) })
    .parse(await c.req.json());
  const qid = id();
  const r = await c.env.DB.prepare(
    "INSERT INTO questions(id,group_id,author_id,text,created_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM questions WHERE group_id=?)<200 RETURNING id",
  )
    .bind(qid, gid, c.get("session").user.id, b.text, now(), gid)
    .first();
  if (!r)
    fail(
      400,
      "This group has enough questions for now. Ask the host to tidy the collection.",
    );
  return c.json({ id: qid }, 201);
});
groups.patch("/:groupId/questions/:questionId", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner", "admin"]);
  const b = z
    .object({
      selected: z.boolean(),
      position: z.number().int().min(0).max(199).default(0),
    })
    .parse(await c.req.json());
  const r = await c.env.DB.prepare(
    `UPDATE questions SET selected=?,position=? WHERE id=? AND group_id=? AND (?=0 OR selected=1 OR (SELECT COUNT(*) FROM questions WHERE group_id=? AND selected=1)<10) RETURNING id`,
  )
    .bind(
      +b.selected,
      b.position,
      c.req.param("questionId"),
      gid,
      +b.selected,
      gid,
    )
    .first();
  if (!r) fail(400, "Select up to ten questions for the next issue.");
  return c.json({ ok: true });
});
groups.get("/:groupId/members", async (c) => {
  const gid = c.req.param("groupId"),
    m = await member(c, gid);
  const admin = m.role !== "member";
  const members = await c.env.DB.prepare(
    `SELECT u.id,u.name,m.role${admin ? ",u.email" : ""} FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND m.active=1 ORDER BY m.joined_at`,
  )
    .bind(gid)
    .all();
  const invitations = admin
    ? (
        await c.env.DB.prepare(
          "SELECT i.id,i.email,i.expires_at,i.accepted_at,i.revoked_at,COALESCE(e.verified,0) AS verified FROM invitations i LEFT JOIN email_destinations e ON e.email=i.email WHERE i.group_id=? ORDER BY i.created_at DESC LIMIT 50",
        )
          .bind(gid)
          .all()
      ).results
    : [];
  return c.json({ members: members.results, invitations });
});
groups.post("/:groupId/invitations", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner", "admin"]);
  const b = z.object({ email: z.email().max(254) }).parse(await c.req.json()),
    email = normalizeEmail(b.email),
    stamp = now();
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) n FROM memberships WHERE group_id=? AND active=1",
  )
    .bind(gid)
    .first<{ n: number }>();
  if (count!.n >= 20)
    fail(400, "This group has reached its twenty-member pilot limit.");
  const secret = token(),
    iid = id();
  const uid = id();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES(?,?,?,?)",
    ).bind(uid, email, email.split("@")[0], stamp),
    c.env.DB.prepare(
      "UPDATE invitations SET revoked_at=? WHERE group_id=? AND email=? AND accepted_at IS NULL AND revoked_at IS NULL",
    ).bind(stamp, gid, email),
    c.env.DB.prepare(
      "INSERT INTO invitations(id,group_id,email,token_hash,inviter_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
    ).bind(
      iid,
      gid,
      email,
      await hash(secret),
      c.get("session").user.id,
      stamp + 7 * 86400000,
      stamp,
    ),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO email_destinations(email,verified,checked_at) VALUES(?,0,?)",
    ).bind(email, stamp),
  ]);
  await audit(c.env, c.get("session").user.id, gid, "invitation.created", iid);
  return c.json(
    {
      id: iid,
      url:
        (c.env.APP_ORIGIN || new URL(c.req.url).origin) +
        "/invite#token=" +
        secret,
    },
    201,
  );
});
groups.delete("/:groupId/invitations/:id", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner", "admin"]);
  await c.env.DB.prepare(
    "UPDATE invitations SET revoked_at=? WHERE id=? AND group_id=? AND accepted_at IS NULL",
  )
    .bind(now(), c.req.param("id"), gid)
    .run();
  return c.json({ ok: true });
});
groups.patch("/:groupId/members/:userId", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner"]);
  const b = z
    .object({ role: z.enum(["admin", "member"]) })
    .parse(await c.req.json());
  const r = await c.env.DB.prepare(
    "UPDATE memberships SET role=? WHERE group_id=? AND user_id=? AND active=1 AND role!='owner' RETURNING user_id",
  )
    .bind(b.role, gid, c.req.param("userId"))
    .first();
  if (!r) fail(400, "The group owner cannot be changed here.");
  await audit(
    c.env,
    c.get("session").user.id,
    gid,
    "member.role",
    c.req.param("userId"),
  );
  return c.json({ ok: true });
});
groups.delete("/:groupId/members/:userId", async (c) => {
  const gid = c.req.param("groupId"),
    m = await member(c, gid),
    target = c.req.param("userId"),
    self = target === m.user_id;
  const other = await c.env.DB.prepare(
    "SELECT role FROM memberships WHERE group_id=? AND user_id=? AND active=1",
  )
    .bind(gid, target)
    .first<Member>();
  if (!other) fail(404, "Member not found.");
  if (other.role === "owner")
    fail(409, "Transfer ownership before leaving the group.");
  if (
    !self &&
    !(m.role === "owner" || (m.role === "admin" && other.role === "member"))
  )
    fail(403, "You cannot remove this member.");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE memberships SET active=0,shared_join_blocked=? WHERE group_id=? AND user_id=?",
    ).bind(+!self, gid, target),
    c.env.DB.prepare(
      "UPDATE email_outbox SET state='skipped',payload=NULL,error_code='membership_removed',updated_at=? WHERE group_id=? AND user_id=? AND state='queued'",
    ).bind(now(), gid, target),
  ]);
  await audit(
    c.env,
    m.user_id,
    gid,
    self ? "member.left" : "member.removed",
    target,
  );
  return c.json({ ok: true });
});
groups.patch("/:groupId/preferences", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid);
  const b = z
    .object({
      opening: z.boolean(),
      reminder: z.boolean(),
      publication: z.boolean(),
    })
    .parse(await c.req.json());
  await c.env.DB.prepare(
    "UPDATE memberships SET notify_open=?,notify_reminder=?,notify_issue=? WHERE group_id=? AND user_id=?",
  )
    .bind(
      +b.opening,
      +b.reminder,
      +b.publication,
      gid,
      c.get("session").user.id,
    )
    .run();
  return c.json({ ok: true });
});
groups.post("/:groupId/transfers", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner"]);
  const b = z.object({ userId: z.uuid() }).parse(await c.req.json());
  const target = await c.env.DB.prepare(
    "SELECT user_id FROM memberships WHERE group_id=? AND user_id=? AND active=1 AND role!=?",
  )
    .bind(gid, b.userId, "owner")
    .first();
  if (!target) fail(400, "Choose an active member to take over.");
  const tid = id(),
    stamp = now(),
    user = c.get("session").user.id;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE transfers SET expires_at=? WHERE group_id=? AND accepted_at IS NULL AND EXISTS(SELECT 1 FROM groups WHERE id=? AND owner_id=? AND deleted_at IS NULL)",
    ).bind(stamp, gid, gid, user),
    c.env.DB.prepare(
      "INSERT INTO transfers(id,group_id,from_user,to_user,expires_at,created_at) SELECT ?,g.id,?,?,?,? FROM groups g JOIN memberships m ON m.group_id=g.id AND m.user_id=? WHERE g.id=? AND g.owner_id=? AND g.deleted_at IS NULL AND m.active=1 AND m.role!='owner' RETURNING id",
    ).bind(
      tid,
      user,
      b.userId,
      stamp + 7 * 86400000,
      stamp,
      b.userId,
      gid,
      user,
    ),
  ]);
  if (!results[1].results.length)
    fail(
      409,
      "The owner or selected member changed. Refresh before trying again.",
    );
  return c.json({ id: tid }, 201);
});
groups.post("/:groupId/transfers/:id/accept", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid);
  const user = c.get("session").user.id,
    stamp = now();
  const t = await c.env.DB.prepare(
    "SELECT * FROM transfers WHERE id=? AND group_id=? AND to_user=? AND accepted_at IS NULL AND expires_at>?",
  )
    .bind(c.req.param("id"), gid, user, stamp)
    .first<{ id: string; from_user: string }>();
  if (!t) fail(404, "Ownership transfer is not available.");
  const rs = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE groups SET owner_id=?,revision=revision+1 WHERE id=? AND owner_id=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=? AND u.deleted_at IS NULL AND m.group_id=? AND m.active=1) RETURNING id",
    ).bind(user, gid, t.from_user, user, gid),
    c.env.DB.prepare(
      "UPDATE memberships SET role='admin' WHERE group_id=? AND user_id=? AND EXISTS(SELECT 1 FROM groups WHERE id=? AND owner_id=?)",
    ).bind(gid, t.from_user, gid, user),
    c.env.DB.prepare(
      "UPDATE memberships SET role='owner' WHERE group_id=? AND user_id=? AND EXISTS(SELECT 1 FROM groups WHERE id=? AND owner_id=?)",
    ).bind(gid, user, gid, user),
    c.env.DB.prepare(
      "UPDATE transfers SET accepted_at=? WHERE id=? AND EXISTS(SELECT 1 FROM groups WHERE id=? AND owner_id=?)",
    ).bind(stamp, t.id, gid, user),
    c.env.DB.prepare(
      "UPDATE transfers SET expires_at=? WHERE group_id=? AND id!=? AND accepted_at IS NULL AND EXISTS(SELECT 1 FROM groups WHERE id=? AND owner_id=?)",
    ).bind(stamp, gid, t.id, gid, user),
  ]);
  if (!rs[0].results.length) fail(409, "Ownership has already changed.");
  await audit(c.env, user, gid, "ownership.transferred", t.from_user);
  return c.json({ ok: true });
});
groups.delete("/:groupId", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner"]);
  const b = z.object({ name: z.string() }).parse(await c.req.json());
  const g = await c.env.DB.prepare("SELECT name FROM groups WHERE id=?")
    .bind(gid)
    .first<{ name: string }>();
  if (b.name !== g!.name) fail(400, "Type the group name exactly to confirm.");
  const stamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE groups SET deleted_at=?,paused=1 WHERE id=?").bind(
      stamp,
      gid,
    ),
    c.env.DB.prepare(
      "UPDATE invitations SET revoked_at=? WHERE group_id=? AND accepted_at IS NULL",
    ).bind(stamp, gid),
    c.env.DB.prepare(
      "UPDATE issues SET state='cancelled',cancelled_at=unixepoch('subsec')*1000 WHERE group_id=? AND state IN ('scheduled','open')",
    ).bind(gid),
    c.env.DB.prepare(
      "UPDATE email_outbox SET state='skipped',payload=NULL,error_code='group_deleted',updated_at=? WHERE group_id=? AND state='queued'",
    ).bind(stamp, gid),
    c.env.DB.prepare(
      "INSERT INTO deletion_records(id,group_id,scope,created_at) VALUES(?,?,'group',?)",
    ).bind(id(), gid, stamp),
  ]);
  return c.json({ ok: true });
});
export const invitations = new Hono<App>();
const invitationToken = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) });
invitations.post("/inspect", async (c) => {
  const { token } = invitationToken.parse(await c.req.json());
  const r = await c.env.DB.prepare(
    "SELECT g.name,g.description,i.email,i.expires_at,i.accepted_at,i.revoked_at,COALESCE(e.verified,0) AS verified FROM invitations i JOIN groups g ON g.id=i.group_id LEFT JOIN email_destinations e ON e.email=i.email WHERE i.token_hash=? AND g.deleted_at IS NULL",
  )
    .bind(await hash(token))
    .first<{
      email: string;
      expires_at: number;
      accepted_at: number | null;
      revoked_at: number | null;
    }>();
  if (!r || r.revoked_at || r.accepted_at || r.expires_at <= now())
    fail(404, "This invitation has expired or is no longer available.");
  return c.json({
    invitation: { ...r, email: r.email.replace(/^(.).+(@.*)$/, "$1•••$2") },
  });
});
invitations.post("/accept", authenticate, async (c) => {
  const { token } = invitationToken.parse(await c.req.json());
  const user = c.get("session").user,
    stamp = now(),
    digest = await hash(token);
  const i = await c.env.DB.prepare(
    "SELECT i.* FROM invitations i JOIN groups g ON g.id=i.group_id WHERE i.token_hash=? AND i.email=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>? AND g.deleted_at IS NULL",
  )
    .bind(digest, user.email, stamp)
    .first<{ id: string; group_id: string }>();
  if (!i)
    fail(404, "Sign in with the invited address and use a current invitation.");
  const r = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO memberships(group_id,user_id,role,joined_at) SELECT ?,?,'member',? WHERE (SELECT COUNT(*) FROM memberships WHERE group_id=? AND active=1)<20 ON CONFLICT(group_id,user_id) DO UPDATE SET role=CASE WHEN memberships.active=0 THEN 'member' ELSE memberships.role END,joined_at=CASE WHEN memberships.active=0 THEN excluded.joined_at ELSE memberships.joined_at END,active=1,shared_join_blocked=0 RETURNING user_id",
    ).bind(i.group_id, user.id, stamp, i.group_id),
    c.env.DB.prepare(
      "UPDATE invitations SET accepted_at=? WHERE id=? AND EXISTS(SELECT 1 FROM memberships WHERE group_id=? AND user_id=? AND active=1)",
    ).bind(stamp, i.id, i.group_id, user.id),
  ]);
  if (!r[0].results.length)
    fail(409, "This group is full. Ask the owner for help.");
  return c.json({ groupId: i.group_id });
});

groups.patch("/:groupId/reminders", async (c) => {
  const gid = c.req.param("groupId");
  await member(c, gid, ["owner", "admin"]);
  const { reminderPolicy } = await import("./reminders");
  const values = reminderPolicy
    .parse((await c.req.json()).hours)
    .sort((a, b) => b - a);
  await c.env.DB.prepare(
    "UPDATE groups SET reminder_offsets_json=?,revision=revision+1 WHERE id=?",
  )
    .bind(JSON.stringify(values), gid)
    .run();
  return c.json({ hours: values });
});
