import { it, expect } from "vitest";
import { harness } from "./harness";
import { runScheduler } from "../server/scheduler";
import { processOutbox } from "../server/mail";
import {
  enqueueQuestionReminders,
  questionDeadline,
} from "../server/question-reminders";
import { selectQuestions } from "../server/question-selection";
import { runCleanup } from "../server/cleanup";
import type { Group, Env } from "../server/types";
const HOUR = 3600000,
  DAY = 24 * HOUR;
const jpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 0, 2, 0, 4, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1,
  0, 0, 63, 0, 12, 13, 255, 217,
]);
it("rotates the bank, includes member questions once, and freezes open issues", async () => {
  const h = await harness();
  try {
    const owner = await h.login("owner@example.test"),
      friend = await h.login("friend@example.test"),
      gid = await h.group(owner);
    await h.invite(owner, friend, gid);
    const question = async (text: string) =>
      await h.request(`/api/groups/${gid}/questions`, {
        method: "POST",
        client: friend,
        body: { text },
      });
    expect((await question("What was your best adventure?")).status).toBe(201);
    const first = await h.issue(owner, gid);
    const rows = await h.db
      .prepare(
        "SELECT text,bank_id,author_id FROM issue_questions WHERE issue_id=? ORDER BY position",
      )
      .bind(first.id)
      .all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].bank_id).toBe("bank-1");
    expect(rows.results[1].author_id).toBe(friend.id);
    await question("What is your next adventure?");
    expect(
      await h.db
        .prepare("SELECT COUNT(*) n FROM issue_questions WHERE issue_id=?")
        .bind(first.id)
        .first(),
    ).toEqual({ n: 2 });
    await h.db
      .prepare("UPDATE issues SET state='skipped' WHERE id=?")
      .bind(first.id)
      .run();
    const second = await h.issue(owner, gid);
    const next = await h.db
      .prepare(
        "SELECT text,bank_id FROM issue_questions WHERE issue_id=? ORDER BY position",
      )
      .bind(second.id)
      .all();
    expect(next.results.map((q) => q.text)).toEqual([
      "What are you looking forward to?",
      "What is your next adventure?",
    ]);
    expect(
      await h.db
        .prepare(
          "SELECT COUNT(*) n FROM questions WHERE group_id=? AND used_issue_id IS NULL",
        )
        .bind(gid)
        .first(),
    ).toEqual({ n: 0 });
  } finally {
    await h.close();
  }
});
it("bounds configurable bank questions, queues overflow, rejects non-host policy edits, and consumes only committed snapshots", async () => {
  const h = await harness();
  try {
    const owner = await h.login("owner@example.test"),
      friend = await h.login("friend@example.test"),
      gid = await h.group(owner);
    await h.invite(owner, friend, gid);
    const path = `/api/groups/${gid}/question-policy`;
    expect(
      (
        await h.request(path, {
          method: "PATCH",
          client: friend,
          body: { bankCount: 2, reminderHours: 24 },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(path, {
          method: "PATCH",
          client: owner,
          body: { bankCount: 6, reminderHours: 24 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request(path, {
          method: "PATCH",
          client: owner,
          body: { bankCount: 2, reminderHours: 24 },
        })
      ).status,
    ).toBe(200);
    for (let n = 0; n < 10; n++)
      await h.request(`/api/groups/${gid}/questions`, {
        method: "POST",
        client: friend,
        body: { text: `Member question number ${n}?` },
      });
    expect(await selectQuestions(h.env, gid)).toHaveLength(10);
    const open = () =>
      h.request(`/api/groups/${gid}/issues`, {
        method: "POST",
        client: owner,
        body: { title: "A letter", deliveryAt: Date.now() + 2 * HOUR },
      });
    const replies = await Promise.all([open(), open()]);
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await h.db
        .prepare(
          "SELECT COUNT(*) n FROM questions WHERE group_id=? AND used_issue_id IS NULL",
        )
        .bind(gid)
        .first(),
    ).toEqual({ n: 2 });
    await h.db
      .prepare("UPDATE issues SET state='skipped' WHERE group_id=?")
      .bind(gid)
      .run();
    await h.db
      .prepare("UPDATE groups SET next_delivery=? WHERE id=?")
      .bind(Date.now() + 7 * DAY + HOUR, gid)
      .run();
    await runScheduler(h.env, Date.now() + 2 * HOUR);
    const queued = await h.db
      .prepare(
        "SELECT q.bank_id,q.source_question_id FROM issue_questions q JOIN issues i ON i.id=q.issue_id WHERE i.state='scheduled' AND i.group_id=?",
      )
      .bind(gid)
      .all();
    expect(queued.results).toHaveLength(4);
    expect(
      queued.results.filter((q) => q.bank_id).map((q) => q.bank_id),
    ).toEqual(["bank-3", "bank-4"]);
  } finally {
    await h.close();
  }
});
it("sends a question reminder in its configured window once, skips offered questions and opt-outs, and rejects stale queued reminders", async () => {
  const h = await harness();
  try {
    const owner = await h.login("owner@example.test"),
      friend = await h.login("friend@example.test"),
      gid = await h.group(owner);
    await h.invite(owner, friend, gid);
    const stamp = Date.now(),
      cutoff = stamp + 12 * HOUR;
    await h.db
      .prepare("UPDATE groups SET next_delivery=?,cadence='weekly' WHERE id=?")
      .bind(cutoff + 7 * DAY, gid)
      .run();
    await h.request(`/api/groups/${gid}/questions`, {
      method: "POST",
      client: friend,
      body: { text: "What made you smile?" },
    });
    await enqueueQuestionReminders(h.env, cutoff - 24 * HOUR - 1);
    expect(
      await h.db
        .prepare(
          "SELECT COUNT(*) n FROM email_outbox WHERE kind='question_reminder'",
        )
        .first(),
    ).toEqual({ n: 0 });
    await enqueueQuestionReminders(h.env, stamp);
    await enqueueQuestionReminders(h.env, stamp + 1);
    expect(
      await h.db
        .prepare(
          "SELECT COUNT(*) n FROM email_outbox WHERE kind='question_reminder'",
        )
        .first(),
    ).toEqual({ n: 1 });
    await processOutbox(h.env, 20);
    const mail = await h.db
      .prepare(
        "SELECT recipient,text,html FROM captured_emails WHERE subject LIKE '%a question for the next letter%'",
      )
      .first<{ recipient: string; text: string; html: string }>();
    expect(mail?.recipient).toBe(owner.email);
    expect(mail?.text).toContain(`/groups/${gid}/questions`);
    expect(mail?.html).toContain("America/Los_Angeles");
    await h.db
      .prepare(
        "UPDATE email_outbox SET state='queued',next_attempt=0 WHERE kind='question_reminder'",
      )
      .run();
    await h.request(`/api/groups/${gid}/preferences`, {
      method: "PATCH",
      client: owner,
      body: {
        opening: true,
        reminder: true,
        publication: true,
        questions: false,
      },
    });
    await processOutbox(h.env, 20);
    expect(
      await h.db
        .prepare(
          "SELECT state,error_code FROM email_outbox WHERE kind='question_reminder'",
        )
        .first(),
    ).toEqual({ state: "skipped", error_code: "membership_or_preference" });
    // Rescheduling must invalidate an already queued question reminder.
    await h.db
      .prepare("UPDATE memberships SET notify_questions=1 WHERE group_id=?")
      .bind(gid)
      .run();
    await h.db
      .prepare(
        "UPDATE groups SET next_delivery=next_delivery+86400000 WHERE id=?",
      )
      .bind(gid)
      .run();
    await h.db
      .prepare(
        "UPDATE email_outbox SET state='queued',next_attempt=0 WHERE kind='question_reminder'",
      )
      .run();
    await processOutbox(h.env, 20);
    expect(
      await h.db
        .prepare(
          "SELECT error_code FROM email_outbox WHERE kind='question_reminder'",
        )
        .first(),
    ).toEqual({ error_code: "question_window_changed" });
    // The next weekly cutoff remains available while the current issue is open.
    const g = await h.db
      .prepare("SELECT * FROM groups WHERE id=?")
      .bind(gid)
      .first<Group>();
    expect(await questionDeadline(g!, stamp)).toBe(cutoff + DAY);
  } finally {
    await h.close();
  }
});
it("defaults submission reminders to 24h, attaches the private configured image, skips submitted members and rechecks before send", async () => {
  const h = await harness();
  try {
    const owner = await h.login("owner@example.test"),
      friend = await h.login("friend@example.test"),
      gid = await h.group(owner);
    await h.invite(owner, friend, gid);
    const upload = await h.request(`/api/groups/${gid}/reminder-image`, {
      method: "POST",
      client: owner,
      raw: jpeg,
      headers: {
        "Content-Type": "image/jpeg",
        "X-Cover-Caption": encodeURIComponent("Please <join> us"),
      },
    });
    expect(upload.status).toBe(201);
    const { id: image } = (await upload.json()) as { id: string };
    expect(
      (
        await h.request(`/api/groups/${gid}/reminder-image`, {
          method: "DELETE",
          client: friend,
        })
      ).status,
    ).toBe(403);
    const issue = await h.issue(owner, gid),
      path = `/api/groups/${gid}/issues/${issue.id}`;
    expect(
      await h.db
        .prepare("SELECT reminder_offsets_json FROM issues WHERE id=?")
        .bind(issue.id)
        .first(),
    ).toEqual({ reminder_offsets_json: "[24]" });
    await h.request(path + "/contribution", {
      method: "PUT",
      client: friend,
      body: {
        revision: 0,
        update: {
          answers: { [issue.qid]: "Already submitted" },
          photos: [],
          good: "",
          shoutout: "",
        },
      },
    });
    await h.request(path + "/submit", {
      method: "POST",
      client: friend,
      body: { revision: 1 },
    });
    await runScheduler(h.env); // opening
    await h.db
      .prepare("UPDATE email_outbox SET state='skipped' WHERE kind='opening'")
      .run();
    const deadline = Date.now() + 24 * HOUR;
    await h.db
      .prepare(
        "UPDATE issues SET deadline=?,delivery_at=?,reminder_at=? WHERE id=?",
      )
      .bind(deadline, deadline, deadline - 24 * HOUR, issue.id)
      .run();
    await runScheduler(h.env, deadline - 24 * HOUR - 1);
    expect(
      await h.db
        .prepare("SELECT COUNT(*) n FROM email_outbox WHERE kind='reminder'")
        .first(),
    ).toEqual({ n: 0 });
    await runScheduler(h.env, deadline - 24 * HOUR);
    await runScheduler(h.env, deadline - 24 * HOUR + 1);
    expect(
      await h.db
        .prepare("SELECT COUNT(*) n FROM email_outbox WHERE kind='reminder'")
        .first(),
    ).toEqual({ n: 1 });
    const sent: Parameters<NonNullable<Env["EMAIL"]>["send"]>[0][] = [];
    await processOutbox(
      {
        ...h.env,
        EMAIL_MODE: "live",
        EMAIL_FROM: "test@example.test",
        EMAIL: {
          send: async (m) => {
            sent.push(m);
            return { messageId: "proof" };
          },
        },
      },
      20,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(owner.email);
    expect(sent[0].html).toContain(`cid:${image}@betterloop`);
    expect(sent[0].html).toContain("Please &lt;join&gt; us");
    expect(new Uint8Array(sent[0].attachments![0].content)).toEqual(jpeg);
    // Image cleanup retains the separately configured reminder asset.
    await h.db
      .prepare("UPDATE group_covers SET created_at=0 WHERE id=?")
      .bind(image)
      .run();
    await runCleanup(h.env);
    expect(
      await h.db
        .prepare("SELECT id FROM group_covers WHERE id=?")
        .bind(image)
        .first(),
    ).toEqual({ id: image });
    // A submission made after queueing still prevents the email from being sent.
    await h.request(path + "/contribution", {
      method: "PUT",
      client: owner,
      body: {
        revision: 0,
        update: { answers: {}, photos: [], good: "Done now", shoutout: "" },
      },
    });
    await h.request(path + "/submit", {
      method: "POST",
      client: owner,
      body: { revision: 1 },
    });
    await h.db
      .prepare(
        "UPDATE email_outbox SET state='queued',next_attempt=0 WHERE kind='reminder'",
      )
      .run();
    await processOutbox(h.env, 20);
    expect(
      await h.db
        .prepare(
          "SELECT state,error_code FROM email_outbox WHERE kind='reminder'",
        )
        .first(),
    ).toEqual({ state: "skipped", error_code: "issue_or_submission_changed" });
  } finally {
    await h.close();
  }
});
it("keeps late member questions for the following issue when automatic planning runs after its cutoff", async () => {
  const h = await harness();
  try {
    const owner = await h.login("owner@example.test"),
      gid = await h.group(owner),
      stamp = Date.now();
    await h.request(`/api/groups/${gid}/questions`, {
      method: "POST",
      client: owner,
      body: { text: "A question after the cutoff?" },
    });
    await h.db
      .prepare("UPDATE groups SET cadence='weekly',next_delivery=? WHERE id=?")
      .bind(stamp + 7 * DAY - HOUR, gid)
      .run();
    await runScheduler(h.env, stamp);
    const issue = await h.db
      .prepare("SELECT id FROM issues WHERE group_id=?")
      .bind(gid)
      .first<{ id: string }>();
    expect(
      await h.db
        .prepare(
          "SELECT COUNT(*) n FROM issue_questions WHERE issue_id=? AND source_question_id IS NOT NULL",
        )
        .bind(issue!.id)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await h.db
        .prepare(
          "SELECT COUNT(*) n FROM questions WHERE group_id=? AND used_issue_id IS NULL",
        )
        .bind(gid)
        .first(),
    ).toEqual({ n: 1 });
  } finally {
    await h.close();
  }
});
