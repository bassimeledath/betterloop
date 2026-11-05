import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { harness } from "./harness";
import { runScheduler } from "../server/scheduler";
import { processOutbox } from "../server/mail";
import { runCleanup } from "../server/cleanup";
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
}, 30000);
afterEach(async () => {
  await h.close();
});
const DAY = 86400000;
async function save(
  owner: Awaited<ReturnType<typeof h.login>>,
  gid: string,
  iid: string,
  submit = false,
) {
  const path = "/api/groups/" + gid + "/issues/" + iid;
  const r = await h.request(path + "/contribution", {
    method: "PUT",
    client: owner,
    body: {
      revision: 0,
      update: {
        answers: {},
        photos: [],
        shoutout: "A private memory",
        good: "",
      },
    },
  });
  expect(r.status).toBe(200);
  if (submit)
    expect(
      (
        await h.request(path + "/submit", {
          method: "POST",
          client: owner,
          body: {
            revision: ((await r.json()) as { revision: number }).revision,
          },
        })
      ).status,
    ).toBe(200);
}

it("replays concurrent issue creation once, including after closure, without bypassing group access", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    requestId = randomUUID(),
    body = { requestId, title: "One intent", deliveryAt: Date.now() + 3600000 },
    path = "/api/groups/" + gid + "/issues";
  const responses = await Promise.all([
    h.request(path, { method: "POST", client: owner, body }),
    h.request(path, { method: "POST", client: owner, body }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
  const results = (await Promise.all(responses.map((r) => r.json()))) as {
      id: string;
    }[],
    iid = results[0].id;
  expect(results[1].id).toBe(iid);
  expect(
    await h.db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM issues WHERE group_id=?) AS issues,(SELECT COUNT(*) FROM issue_questions WHERE issue_id=?) AS questions,(SELECT COUNT(*) FROM audit_events WHERE action='issue.opened' AND target=?) AS events",
      )
      .bind(gid, iid, iid)
      .first(),
  ).toEqual({ issues: 1, questions: 1, events: 1 });
  await h.db
    .prepare("UPDATE issues SET state='cancelled' WHERE id=?")
    .bind(iid)
    .run();
  const replay = await h.request(path, {
    method: "POST",
    client: owner,
    body: { ...body, deliveryAt: Date.now() - 60000 },
  });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ id: iid });
  expect(
    await h.db
      .prepare("SELECT COUNT(*) AS n FROM issues WHERE group_id=?")
      .bind(gid)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    (
      await h.request("/api/groups/" + gid, {
        method: "DELETE",
        client: owner,
        body: { name: "Test circle" },
      })
    ).status,
  ).toBe(200);
  expect(
    (await h.request(path, { method: "POST", client: owner, body })).status,
  ).toBe(404);
});

it("reuses one export and one source manifest for concurrent retries without spending additional daily quota", async () => {
  const owner = await h.login("owner@example.test"),
    requestId = randomUUID(),
    path = "/api/me/exports";
  const responses = await Promise.all([
    h.request(path, { method: "POST", client: owner, body: { requestId } }),
    h.request(path, { method: "POST", client: owner, body: { requestId } }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
  const results = (await Promise.all(responses.map((r) => r.json()))) as {
      id: string;
    }[],
    jid = results[0].id;
  expect(results[1].id).toBe(jid);
  expect(
    await h.db
      .prepare("SELECT COUNT(*) AS n FROM export_files WHERE job_id=?")
      .bind(jid)
      .first(),
  ).toEqual({ n: 1 });
  for (let n = 0; n < 8; n++)
    expect(
      (
        await h.request(path, {
          method: "POST",
          client: owner,
          body: { requestId },
        })
      ).status,
    ).toBe(200);
  await h.db
    .prepare("UPDATE exports SET state='ready' WHERE id=?")
    .bind(jid)
    .run();
  for (let n = 0; n < 2; n++) {
    const r = await h.request(path, {
      method: "POST",
      client: owner,
      body: { requestId: randomUUID() },
    });
    expect(r.status).toBe(201);
    await h.db
      .prepare("UPDATE exports SET state='ready' WHERE id=?")
      .bind(((await r.json()) as { id: string }).id)
      .run();
  }
  expect(
    (
      await h.request(path, {
        method: "POST",
        client: owner,
        body: { requestId: randomUUID() },
      })
    ).status,
  ).toBe(429);
  const replay = await h.request(path, {
    method: "POST",
    client: owner,
    body: { requestId },
  });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ id: jid });
  expect(
    await h.db
      .prepare("SELECT COUNT(*) AS n FROM exports WHERE user_id=?")
      .bind(owner.id)
      .first(),
  ).toEqual({ n: 3 });
});

it("scopes export replay to the owner and export kind, and keeps expired copies inaccessible", async () => {
  const owner = await h.login("owner@example.test"),
    friend = await h.login("friend@example.test"),
    gid = await h.group(owner),
    requestId = randomUUID();
  const first = await h.request("/api/me/exports", {
      method: "POST",
      client: owner,
      body: { requestId },
    }),
    jid = ((await first.json()) as { id: string }).id;
  await h.db
    .prepare("UPDATE exports SET state='expired',expires_at=? WHERE id=?")
    .bind(Date.now() - 1, jid)
    .run();
  const replay = await h.request("/api/me/exports", {
    method: "POST",
    client: owner,
    body: { requestId },
  });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ id: jid });
  expect(
    (await h.request("/api/exports/" + jid + "/download", { client: owner }))
      .status,
  ).toBe(404);
  const group = await h.request("/api/groups/" + gid + "/exports", {
    method: "POST",
    client: owner,
    body: { requestId },
  });
  expect(group.status).toBe(201);
  expect(((await group.json()) as { id: string }).id).not.toBe(jid);
  const other = await h.request("/api/me/exports", {
    method: "POST",
    client: friend,
    body: { requestId },
  });
  expect(other.status).toBe(201);
  expect(((await other.json()) as { id: string }).id).not.toBe(jid);
  expect(
    (
      await h.request("/api/groups/" + gid + "/exports", {
        method: "POST",
        client: friend,
        body: { requestId },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await h.request("/api/me/exports", {
        method: "POST",
        client: owner,
        raw: new TextEncoder().encode("{"),
        headers: { "Content-Type": "application/json" },
      })
    ).status,
  ).toBe(400);
});

it("finishes a paused current issue without opening future issues, then resumes at a future recurrence", async () => {
  const owner = await h.login("owner@example.test"),
    friend = await h.login("friend@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid),
    stamp = Date.now();
  await h.invite(owner, friend, gid);
  await save(owner, gid, issue.id, true);
  await runScheduler(h.env);
  await runScheduler(h.env);
  expect(
    (
      await h.request("/api/groups/" + gid + "/pause", {
        method: "POST",
        client: owner,
        body: { paused: true, current: "finish" },
      })
    ).status,
  ).toBe(200);
  const pausedMail = await h.db
    .prepare(
      "SELECT state FROM email_outbox WHERE issue_id=? AND kind IN ('opening','reminder')",
    )
    .bind(issue.id)
    .all();
  expect(pausedMail.results).toHaveLength(3);
  expect(pausedMail.results.every((r) => r.state === "skipped")).toBe(true);
  const row = await h.db
    .prepare("SELECT state,deadline FROM issues WHERE id=?")
    .bind(issue.id)
    .first<{ state: string; deadline: number }>();
  expect(row!.state).toBe("open");
  await runScheduler(h.env, row!.deadline + 1);
  await runScheduler(h.env, stamp + 365 * DAY);
  expect(
    await h.db
      .prepare("SELECT COUNT(*) AS n FROM publications WHERE group_id=?")
      .bind(gid)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    await h.db
      .prepare("SELECT COUNT(*) AS n FROM issues WHERE group_id=?")
      .bind(gid)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    (
      await h.request("/api/groups/" + gid + "/pause", {
        method: "POST",
        client: owner,
        body: { paused: false },
      })
    ).status,
  ).toBe(200);
  const group = await h.db
    .prepare("SELECT paused,next_delivery FROM groups WHERE id=?")
    .bind(gid)
    .first<{ paused: number; next_delivery: number }>();
  expect(group!.paused).toBe(0);
  expect(group!.next_delivery).toBeGreaterThan(stamp);
});

it("cancels a paused current issue, rejects later writes and expires its private draft after thirty days", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid);
  await save(owner, gid, issue.id);
  await runScheduler(h.env);
  expect(
    (
      await h.request("/api/groups/" + gid + "/pause", {
        method: "POST",
        client: owner,
        body: { paused: true, current: "cancel" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.request(
        "/api/groups/" + gid + "/issues/" + issue.id + "/submit",
        { method: "POST", client: owner, body: { revision: 1 } },
      )
    ).status,
  ).toBe(409);
  const row = await h.db
    .prepare("SELECT cancelled_at FROM issues WHERE id=?")
    .bind(issue.id)
    .first<{ cancelled_at: number }>();
  await runScheduler(h.env, row!.cancelled_at + 2 * DAY);
  expect(
    await h.db
      .prepare("SELECT issue_id FROM publications WHERE issue_id=?")
      .bind(issue.id)
      .first(),
  ).toBeNull();
  await runCleanup(h.env, row!.cancelled_at + 29 * DAY);
  expect(
    await h.db
      .prepare("SELECT draft_json FROM contributions WHERE issue_id=?")
      .bind(issue.id)
      .first(),
  ).not.toBeNull();
  await runCleanup(h.env, row!.cancelled_at + 31 * DAY);
  expect(
    await h.db
      .prepare("SELECT draft_json FROM contributions WHERE issue_id=?")
      .bind(issue.id)
      .first(),
  ).toBeNull();
});

it("extends an issue without publishing at the old deadline and schedules a fresh reminder for the new deadline", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid),
    stamp = Date.now(),
    path = "/api/groups/" + gid + "/issues/" + issue.id;
  await runScheduler(h.env);
  await runScheduler(h.env);
  const original = await h.db
      .prepare("SELECT deadline FROM issues WHERE id=?")
      .bind(issue.id)
      .first<{ deadline: number }>(),
    extended = stamp + 4 * DAY;
  expect(
    (
      await h.request(path, {
        method: "PATCH",
        client: owner,
        body: { action: "extend", deadline: extended },
      })
    ).status,
  ).toBe(200);
  const prior = await h.db
    .prepare(
      "SELECT state FROM email_outbox WHERE issue_id=? AND kind='reminder'",
    )
    .bind(issue.id)
    .all<{ state: string }>();
  expect(prior.results).toHaveLength(1);
  expect(prior.results[0].state).toBe("skipped");
  await runScheduler(h.env, original!.deadline + 1);
  expect(
    await h.db
      .prepare("SELECT state,deadline FROM issues WHERE id=?")
      .bind(issue.id)
      .first(),
  ).toEqual({ state: "open", deadline: extended });
  await runScheduler(h.env, extended - DAY + 1);
  const reminders = await h.db
    .prepare(
      "SELECT state FROM email_outbox WHERE issue_id=? AND kind='reminder'",
    )
    .bind(issue.id)
    .all<{ state: string }>();
  expect(reminders.results.map((r) => r.state).sort()).toEqual([
    "queued",
    "skipped",
  ]);
  expect(
    (
      await h.request(path, {
        method: "PATCH",
        client: owner,
        body: { action: "extend", deadline: stamp },
      })
    ).status,
  ).toBe(400);
});

it("fences a reminder selected before an extension and skips a stale job that reaches the sender", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid),
    stamp = Date.now(),
    extended = stamp + 4 * DAY;
  await runScheduler(h.env);
  const original = await h.db
    .prepare("SELECT deadline FROM issues WHERE id=?")
    .bind(issue.id)
    .first<{ deadline: number }>();
  let injected = false;
  const db = new Proxy(h.db, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          if (!injected) {
            injected = true;
            expect(
              (
                await h.request("/api/groups/" + gid + "/issues/" + issue.id, {
                  method: "PATCH",
                  client: owner,
                  body: { action: "extend", deadline: extended },
                })
              ).status,
            ).toBe(200);
          }
          return result;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await runScheduler({ ...h.env, DB: db });
  expect(injected).toBe(true);
  expect(
    await h.db
      .prepare("SELECT reminded_at FROM issues WHERE id=?")
      .bind(issue.id)
      .first(),
  ).toEqual({ reminded_at: null });
  expect(
    (
      await h.db
        .prepare(
          "SELECT id FROM email_outbox WHERE issue_id=? AND kind='reminder'",
        )
        .bind(issue.id)
        .all()
    ).results,
  ).toHaveLength(0);
  await h.db
    .prepare(
      "INSERT INTO email_outbox(id,logical_key,group_id,issue_id,user_id,recipient,kind,next_attempt,created_at,updated_at,reminder_deadline) VALUES('stale','stale',?,?,?,?,'reminder',?,?,?,?)",
    )
    .bind(
      gid,
      issue.id,
      owner.id,
      owner.email,
      stamp,
      stamp,
      stamp,
      original!.deadline,
    )
    .run();
  const before = await h.db
    .prepare("SELECT COUNT(*) AS n FROM captured_emails")
    .first();
  await processOutbox(h.env);
  expect(
    await h.db
      .prepare("SELECT state,error_code FROM email_outbox WHERE id='stale'")
      .first(),
  ).toEqual({ state: "skipped", error_code: "issue_or_submission_changed" });
  expect(
    await h.db.prepare("SELECT COUNT(*) AS n FROM captured_emails").first(),
  ).toEqual(before);
  await runScheduler(h.env, extended - DAY + 1);
  expect(
    (
      await h.db
        .prepare(
          "SELECT reminder_deadline FROM email_outbox WHERE issue_id=? AND kind='reminder' AND state='queued'",
        )
        .bind(issue.id)
        .all()
    ).results,
  ).toEqual([{ reminder_deadline: extended }]);
});
