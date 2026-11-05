import type { Env, Group } from "./types";
import { now } from "./security";
import { catchUpDelivery } from "./scheduler";
const WEEK = 7 * 86400000;
// Find the next answer window that has not started, including during an open issue.
export async function questionDeadline(group: Group, stamp = now()) {
  return (
    (await catchUpDelivery(group.next_delivery, stamp + WEEK - 1, group)) - WEEK
  );
}
export async function enqueueQuestionReminders(env: Env, stamp = now()) {
  const groups = (
    await env.DB.prepare(
      "SELECT * FROM groups WHERE paused=0 AND deleted_at IS NULL AND question_reminder_hours>0 AND next_delivery<=?",
    )
      .bind(stamp + WEEK + 7 * 86400000)
      .all<Group>()
  ).results;
  for (const group of groups) {
    const deadline = await questionDeadline(group, stamp);
    if (
      deadline <= stamp ||
      deadline - (group.question_reminder_hours ?? 24) * 3600000 > stamp
    )
      continue;
    // One email per member and cutoff. Skip people who have already offered a question.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO email_outbox(id,logical_key,group_id,user_id,recipient,kind,expires_at,next_attempt,created_at,updated_at) SELECT lower(hex(randomblob(16))),?||':question:'||?||':'||m.user_id,m.group_id,m.user_id,u.email,'question_reminder',?,?,?,? FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND m.active=1 AND m.notify_questions=1 AND u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM questions q WHERE q.group_id=m.group_id AND q.author_id=m.user_id AND q.used_issue_id IS NULL AND q.source='member' AND q.selected=1)",
    )
      .bind(group.id, deadline, deadline, stamp, stamp, stamp, group.id)
      .run();
  }
}
