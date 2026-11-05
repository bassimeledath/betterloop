import { questionBank } from "../shared/question-bank";
import type { Env } from "./types";
import { id } from "./security";
export async function selectQuestions(
  env: Env,
  gid: string,
  cutoff = Number.MAX_SAFE_INTEGER,
) {
  const group = await env.DB.prepare(
    "SELECT bank_question_count FROM groups WHERE id=?",
  )
    .bind(gid)
    .first<{ bank_question_count: number }>();
  const history = (
    await env.DB.prepare(
      "SELECT q.bank_id,MAX(i.created_at) AS last_used FROM issue_questions q JOIN issues i ON i.id=q.issue_id WHERE q.group_id=? AND q.bank_id IS NOT NULL GROUP BY q.bank_id",
    )
      .bind(gid)
      .all<{ bank_id: string; last_used: number }>()
  ).results;
  const bank = [...questionBank]
    .sort(
      (a, b) =>
        (history.find((h) => h.bank_id === a.id)?.last_used || 0) -
        (history.find((h) => h.bank_id === b.id)?.last_used || 0),
    )
    .slice(0, group?.bank_question_count ?? 1);
  const members = (
    await env.DB.prepare(
      "SELECT q.id,q.text,q.author_id,u.name AS author_name FROM questions q JOIN users u ON u.id=q.author_id JOIN memberships m ON m.user_id=q.author_id AND m.group_id=q.group_id WHERE q.group_id=? AND q.source='member' AND q.created_at<? AND q.used_issue_id IS NULL AND q.selected=1 AND m.active=1 AND u.deleted_at IS NULL ORDER BY q.position,q.created_at,q.id LIMIT ?",
    )
      .bind(gid, cutoff, 10 - bank.length)
      .all<{
        id: string;
        text: string;
        author_id: string;
        author_name: string;
      }>()
  ).results;
  return [
    ...bank.map((q) => ({
      text: q.text,
      author_id: null as string | null,
      author_name: "Betterloop",
      bank_id: q.id as string | null,
      source_question_id: null as string | null,
    })),
    ...members.map((q) => ({
      ...q,
      bank_id: null as string | null,
      source_question_id: q.id as string | null,
    })),
  ];
}
export function snapshotQuestions(
  env: Env,
  gid: string,
  iid: string,
  qs: Awaited<ReturnType<typeof selectQuestions>>,
) {
  return [
    ...qs.map((q, j) =>
      env.DB.prepare(
        "INSERT INTO issue_questions(id,issue_id,group_id,text,author_name,position,author_id,bank_id,source_question_id) SELECT ?,id,?,?,?,?,?,?,? FROM issues WHERE id=?",
      ).bind(
        id(),
        gid,
        q.text,
        q.author_name,
        j,
        q.author_id,
        q.bank_id,
        q.source_question_id,
        iid,
      ),
    ),
    env.DB.prepare(
      "UPDATE questions SET used_issue_id=?,selected=0 WHERE group_id=? AND used_issue_id IS NULL AND id IN (SELECT source_question_id FROM issue_questions WHERE issue_id=?)",
    ).bind(iid, gid, iid),
  ];
}
