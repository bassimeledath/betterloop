import type { Env, Group, Issue, Publication, Update } from "./types";
import { id, now } from "./security";
import { reminderTime, offsets } from "./reminders";
import type { Recurrence } from "../shared/schedule";
export async function catchUpDelivery(
  previous: number,
  stamp: number,
  g: Pick<Group, "timezone" | "cadence" | "recurrence_json">,
) {
  if (previous > stamp) return previous;
  const { Temporal } = await import("@js-temporal/polyfill");
  const { nextDelivery } = await import("../shared/schedule");
  const rule = JSON.parse(g.recurrence_json) as Recurrence;
  if (g.cadence === "monthly")
    return nextDelivery(stamp, g.timezone, g.cadence, rule);
  const prior = Temporal.Instant.fromEpochMilliseconds(
      previous,
    ).toZonedDateTimeISO(g.timezone),
    current = Temporal.Instant.fromEpochMilliseconds(stamp).toZonedDateTimeISO(
      g.timezone,
    ),
    period = g.cadence === "fortnightly" ? 14 : 7;
  const elapsed = prior.toPlainDate().until(current.toPlainDate()).days;
  let candidate = prior.add({
    days: Math.max(0, Math.floor(elapsed / period)) * period,
  });
  if (candidate.epochMilliseconds <= stamp)
    candidate = candidate.add({ days: period });
  return candidate.epochMilliseconds;
}
export async function enqueueIssueMail(
  env: Env,
  issue: Issue,
  kind: "opening" | "reminder" | "publication",
) {
  const stamp = now();
  const preference =
    kind === "opening"
      ? "notify_open"
      : kind === "reminder"
        ? "notify_reminder"
        : "notify_issue";
  const people = (
    await env.DB.prepare(
      `SELECT m.user_id,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND m.active=1 AND m.${preference}=1 AND u.deleted_at IS NULL ${kind === "reminder" ? "AND NOT EXISTS(SELECT 1 FROM contributions c WHERE c.issue_id=? AND c.user_id=m.user_id AND c.submitted_json IS NOT NULL)" : ""}`,
    )
      .bind(
        ...(kind === "reminder"
          ? [issue.group_id, issue.id]
          : [issue.group_id]),
      )
      .all<{ user_id: string; email: string }>()
  ).results;
  if (!people.length) return;
  await env.DB.batch(
    people.map((p) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO email_outbox(id,logical_key,group_id,issue_id,user_id,recipient,kind,next_attempt,created_at,updated_at,reminder_deadline) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ?!='reminder' OR EXISTS(SELECT 1 FROM issues WHERE id=? AND state='open' AND deadline=?)`,
      ).bind(
        id(),
        `${issue.id}:${kind}${kind === "reminder" ? ":" + issue.deadline + ":" + issue.reminder_at : ""}:${p.user_id}`,
        issue.group_id,
        issue.id,
        p.user_id,
        p.email,
        kind,
        stamp,
        stamp,
        stamp,
        kind === "reminder" ? issue.deadline : null,
        kind,
        issue.id,
        issue.deadline,
      ),
    ),
  );
}
async function plan(env: Env, stamp: number) {
  const g = await env.DB.prepare(
    "SELECT * FROM groups g WHERE paused=0 AND deleted_at IS NULL AND next_delivery<=? AND EXISTS(SELECT 1 FROM questions q WHERE q.group_id=g.id AND q.selected=1) AND NOT EXISTS(SELECT 1 FROM issues i WHERE i.group_id=g.id AND i.state IN ('scheduled','open','closing')) ORDER BY next_delivery LIMIT 1",
  )
    .bind(stamp + 7 * 86400000)
    .first<Group>();
  if (!g) return;
  const { advanceDelivery } = await import("../shared/schedule");
  const delivery = await catchUpDelivery(g.next_delivery, stamp, g),
    future = advanceDelivery(
      delivery,
      g.timezone,
      g.cadence,
      JSON.parse(g.recurrence_json),
    );
  if (delivery > stamp + 7 * 86400000) {
    await env.DB.prepare(
      "UPDATE groups SET next_delivery=? WHERE id=? AND next_delivery=?",
    )
      .bind(delivery, g.id, g.next_delivery)
      .run();
    return;
  }
  const qs = (
    await env.DB.prepare(
      "SELECT q.text,q.author_id,u.name AS author_name FROM questions q LEFT JOIN users u ON u.id=q.author_id WHERE q.group_id=? AND q.selected=1 ORDER BY q.position,q.created_at LIMIT 10",
    )
      .bind(g.id)
      .all<{ text: string; author_id: string | null; author_name: string }>()
  ).results;
  if (!qs.length) return;
  const iid = id();
  const title =
    new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: g.timezone,
    }).format(delivery) + " letter";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO issues(id,group_id,title,opens_at,deadline,delivery_at,state,reminder_at,created_at,reminder_offsets_json) SELECT ?,?,?,?,?,?,'scheduled',?,?,? WHERE EXISTS(SELECT 1 FROM groups WHERE id=? AND next_delivery=? AND paused=0 AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM issues WHERE group_id=? AND state IN ('scheduled','open','closing'))",
    ).bind(
      iid,
      g.id,
      title,
      delivery - 7 * 86400000,
      delivery,
      delivery,
      reminderTime(delivery, offsets(g.reminder_offsets_json)[0]),
      stamp,
      g.reminder_offsets_json || "[48]",
      g.id,
      g.next_delivery,
      g.id,
    ),
    ...qs.map((q, j) =>
      env.DB.prepare(
        "INSERT INTO issue_questions(id,issue_id,group_id,text,author_name,position,author_id) SELECT ?,id,?,?,?,?,? FROM issues WHERE id=?",
      ).bind(
        id(),
        g.id,
        q.text,
        q.author_name || "The group",
        j,
        q.author_id || null,
        iid,
      ),
    ),
    env.DB.prepare(
      "UPDATE groups SET next_delivery=? WHERE id=? AND next_delivery=? AND EXISTS(SELECT 1 FROM issues WHERE id=?)",
    ).bind(future, g.id, g.next_delivery, iid),
  ]);
}
async function publish(env: Env, issue: Issue, stamp: number) {
  const g = await env.DB.prepare(
    "SELECT g.name,g.deleted_at,g.cover_id,c.caption AS cover_caption FROM groups g LEFT JOIN group_covers c ON c.id=g.cover_id WHERE g.id=?",
  )
    .bind(issue.group_id)
    .first<{
      name: string;
      deleted_at: number | null;
      cover_id: string | null;
      cover_caption: string | null;
    }>();
  if (!g || g.deleted_at) {
    await env.DB.prepare(
      "UPDATE issues SET state='cancelled' WHERE id=? AND state='closing'",
    )
      .bind(issue.id)
      .run();
    return;
  }
  const people = (
    await env.DB.prepare(
      "SELECT c.user_id,u.name,c.submitted_json FROM contributions c JOIN users u ON u.id=c.user_id JOIN memberships m ON m.user_id=c.user_id AND m.group_id=c.group_id WHERE c.issue_id=? AND c.group_id=? AND c.submitted_json IS NOT NULL AND m.active=1 AND u.deleted_at IS NULL ORDER BY m.joined_at",
    )
      .bind(issue.id, issue.group_id)
      .all<{ user_id: string; name: string; submitted_json: string }>()
  ).results;
  if (!people.length) {
    await env.DB.prepare(
      "UPDATE issues SET state='skipped' WHERE id=? AND state='closing'",
    )
      .bind(issue.id)
      .run();
    return;
  }
  const questions = (
    await env.DB.prepare(
      "SELECT id,text,author_id,author_name FROM issue_questions WHERE issue_id=? AND group_id=? ORDER BY position",
    )
      .bind(issue.id, issue.group_id)
      .all<{
        id: string;
        text: string;
        author_id: string | null;
        author_name: string;
      }>()
  ).results;
  const content: Publication = {
    schemaVersion: 1,
    groupName: g.name,
    coverId: g.cover_id,
    coverCaption: g.cover_caption || "",
    title: issue.title,
    questions,
    contributors: people.map((p) => ({
      id: p.user_id,
      name: p.name,
      update: JSON.parse(p.submitted_json) as Update,
    })),
  };
  const json = JSON.stringify(content);
  if (new TextEncoder().encode(json).byteLength > 500000)
    throw new Error("Publication exceeds bounded snapshot size");
  // One committed snapshot and one set of logical outbox keys, including on replay.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO publications(issue_id,group_id,content_json,published_at) SELECT id,group_id,?,? FROM issues WHERE id=? AND state='closing'",
    ).bind(json, stamp, issue.id),
    env.DB.prepare(
      "UPDATE issues SET state='published',revision=revision+1 WHERE id=? AND state='closing' AND EXISTS(SELECT 1 FROM publications WHERE issue_id=?)",
    ).bind(issue.id, issue.id),
    env.DB.prepare(
      "INSERT OR IGNORE INTO email_outbox(id,logical_key,group_id,issue_id,user_id,recipient,kind,next_attempt,created_at,updated_at) SELECT lower(hex(randomblob(16))),? || ':publication:' || m.user_id,m.group_id,?,m.user_id,u.email,'publication',?,?,? FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND m.active=1 AND m.notify_issue=1 AND u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM publications WHERE issue_id=?)",
    ).bind(issue.id, issue.id, stamp, stamp, stamp, issue.group_id, issue.id),
  ]);
}
export async function runScheduler(env: Env, stamp = now()) {
  // Read the bounded candidates together; mutations still follow their priority.
  const checks = await env.DB.batch<Issue>([
    env.DB.prepare(
      "SELECT * FROM issues WHERE state='closing' OR (state IN ('scheduled','open') AND deadline<=?) ORDER BY CASE WHEN state='closing' THEN 0 ELSE 1 END,deadline LIMIT 1",
    ).bind(stamp),
    env.DB.prepare(
      "SELECT i.* FROM issues i JOIN groups g ON g.id=i.group_id WHERE i.state='scheduled' AND i.opens_at<=? AND i.deadline>? AND g.paused=0 AND g.deleted_at IS NULL ORDER BY i.opens_at LIMIT 1",
    ).bind(stamp, stamp),
    env.DB.prepare(
      "SELECT i.* FROM issues i JOIN groups g ON g.id=i.group_id WHERE i.state='open' AND i.deadline>? AND g.paused=0 AND g.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM service_state WHERE key='opened:'||i.id) ORDER BY i.opens_at LIMIT 1",
    ).bind(stamp),
    env.DB.prepare(
      "SELECT i.* FROM issues i JOIN groups g ON g.id=i.group_id WHERE i.state='open' AND i.reminder_at<=? AND i.deadline>? AND i.reminded_at IS NULL AND g.paused=0 AND g.deleted_at IS NULL ORDER BY i.reminder_at LIMIT 1",
    ).bind(stamp, stamp),
  ]);
  const [issue, ready, opening, reminder] = checks.map((r) => r.results[0]);
  if (issue) {
    if (issue.state !== "closing")
      await env.DB.prepare(
        "UPDATE issues SET state='closing' WHERE id=? AND state IN ('scheduled','open') AND deadline<=?",
      )
        .bind(issue.id, stamp)
        .run();
    await publish(env, { ...issue, state: "closing" }, stamp);
    return;
  }
  if (ready) {
    await env.DB.prepare(
      "UPDATE issues SET state='open' WHERE id=? AND state='scheduled'",
    )
      .bind(ready.id)
      .run();
    await enqueueIssueMail(env, ready, "opening");
    return;
  }
  if (opening) {
    await enqueueIssueMail(env, opening, "opening");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO service_state(key,value,updated_at) VALUES(?,?,?)",
    )
      .bind("opened:" + opening.id, "ok", stamp)
      .run();
    return;
  }
  if (reminder) {
    const policy = offsets(reminder.reminder_offsets_json);
    let index = reminder.reminder_index || 0;
    while (
      index + 1 < policy.length &&
      reminderTime(reminder.deadline, policy[index + 1]) <= stamp
    )
      index++;
    const due = reminderTime(reminder.deadline, policy[index]);
    await enqueueIssueMail(env, { ...reminder, reminder_at: due }, "reminder");
    await env.DB.prepare(
      "UPDATE issues SET reminder_index=?,reminder_at=?,reminded_at=? WHERE id=? AND reminded_at IS NULL AND state='open' AND deadline=? AND reminder_at=?",
    )
      .bind(
        index + 1,
        index + 1 < policy.length
          ? reminderTime(reminder.deadline, policy[index + 1])
          : reminder.reminder_at,
        index + 1 < policy.length ? null : stamp,
        reminder.id,
        reminder.deadline,
        reminder.reminder_at,
      )
      .run();
    return;
  }
  await plan(env, stamp);
}
