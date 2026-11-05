import { beforeEach, afterEach, it, expect } from "vitest";
import { harness } from "./harness";
import { runScheduler } from "../server/scheduler";
import { processOutbox } from "../server/mail";
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
}, 30000);
afterEach(async () => {
  await h.close();
});
const DAY = 86400000;

it("restores a partial draft in a new session, resubmits edits, rejects stale and closed writes, and publishes the latest submitted copy", async () => {
  const owner = await h.login("writer@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid);
  const path = `/api/groups/${gid}/issues/${issue.id}`;
  const update = {
    answers: { [issue.qid]: "First sitting" },
    photos: [],
    shoutout: "",
    good: "",
  };
  const save = (revision: number, text: string, client = owner) =>
    h.request(path + "/contribution", {
      method: "PUT",
      client,
      body: { revision, update: { ...update, answers: { [issue.qid]: text } } },
    });
  expect((await save(0, "First sitting")).status).toBe(200);
  const secondSession = await h.login("writer@example.test");
  const returned = (await (
    await h.request(path, { client: secondSession })
  ).json()) as any;
  expect(returned.contribution.draft.answers[issue.qid]).toBe("First sitting");
  expect(
    (
      await h.request(path + "/submit", {
        method: "POST",
        client: secondSession,
        body: { revision: 1 },
      })
    ).status,
  ).toBe(200);
  expect((await save(2, "Second sitting", secondSession)).status).toBe(200);
  expect((await save(2, "Stale other tab")).status).toBe(409);
  expect(
    (
      await h.request(path + "/submit", {
        method: "POST",
        client: secondSession,
        body: { revision: 3 },
      })
    ).status,
  ).toBe(200);
  expect((await save(4, "Unsubmitted extra edit", secondSession)).status).toBe(
    200,
  );
  await h.db
    .prepare("UPDATE issues SET deadline=? WHERE id=?")
    .bind(Date.now() - 1, issue.id)
    .run();
  for (const action of ["submit", "withdraw"])
    expect(
      (
        await h.request(path + "/" + action, {
          method: "POST",
          client: owner,
          body: { revision: 5 },
        })
      ).status,
    ).toBe(409);
  expect((await save(5, "Too late")).status).toBe(409);
  await runScheduler(h.env);
  const final = (await (
    await h.request(path, { client: owner })
  ).json()) as any;
  expect(final.publication.contributors[0].update.answers[issue.qid]).toBe(
    "Second sitting",
  );
  expect(final.contribution.draft.answers[issue.qid]).toBe(
    "Unsubmitted extra edit",
  );
});

it("withdraws while retaining a revisitable draft and excludes it from publication", async () => {
  const owner = await h.login("writer@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid),
    path = `/api/groups/${gid}/issues/${issue.id}`;
  await h.request(path + "/contribution", {
    method: "PUT",
    client: owner,
    body: {
      revision: 0,
      update: {
        answers: {},
        photos: [],
        shoutout: "A saved thought",
        good: "",
      },
    },
  });
  await h.request(path + "/submit", {
    method: "POST",
    client: owner,
    body: { revision: 1 },
  });
  expect(
    (
      await h.request(path + "/withdraw", {
        method: "POST",
        client: owner,
        body: { revision: 2 },
      })
    ).status,
  ).toBe(200);
  const data = (await (await h.request(path, { client: owner })).json()) as any;
  expect(data.contribution.submitted).toBeNull();
  expect(data.contribution.draft.shoutout).toBe("A saved thought");
  await h.db
    .prepare("UPDATE issues SET deadline=? WHERE id=?")
    .bind(Date.now() - 1, issue.id)
    .run();
  await runScheduler(h.env);
  const closed = (await (
    await h.request(path, { client: owner })
  ).json()) as any;
  expect(closed.publication).toBeNull();
  expect(closed.issue.state).toBe("skipped");
});

it("sends one reminder in its pre-deadline window and never sends an expired queued reminder", async () => {
  const owner = await h.login("writer@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid),
    stamp = Date.now();
  const deadline = stamp + 4 * DAY,
    reminder = deadline - 2 * DAY;
  await h.db
    .prepare(
      "UPDATE issues SET deadline=?,delivery_at=?,reminder_at=? WHERE id=?",
    )
    .bind(deadline, deadline, reminder, issue.id)
    .run();
  await runScheduler(h.env, stamp); // opening
  await processOutbox(h.env, 20);
  await runScheduler(h.env, reminder - 1);
  const count = () =>
    h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM email_outbox WHERE issue_id=? AND kind='reminder'",
      )
      .bind(issue.id)
      .first();
  expect(await count()).toEqual({ n: 0 });
  await runScheduler(h.env, reminder);
  await runScheduler(h.env, reminder + 1);
  expect(await count()).toEqual({ n: 1 });
  await processOutbox(h.env, 20);
  const mail = await h.db
    .prepare("SELECT text FROM captured_emails WHERE subject LIKE '%reminder%'")
    .first<{ text: string }>();
  expect(mail?.text).toContain("Answers due");
  expect(mail?.text).toContain(`/groups/${gid}/issues/${issue.id}`);
  await h.db
    .prepare(
      "UPDATE email_outbox SET state='queued',next_attempt=0 WHERE issue_id=? AND kind='reminder'",
    )
    .bind(issue.id)
    .run();
  await h.db
    .prepare("UPDATE issues SET deadline=? WHERE id=?")
    .bind(Date.now() - 1, issue.id)
    .run();
  await processOutbox(h.env, 20);
  expect(
    await h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM captured_emails WHERE subject LIKE '%reminder%'",
      )
      .first(),
  ).toEqual({ n: 1 });
  expect(
    await h.db
      .prepare(
        "SELECT state FROM email_outbox WHERE issue_id=? AND kind='reminder'",
      )
      .bind(issue.id)
      .first(),
  ).toEqual({ state: "skipped" });
});

// Desired behavior, currently fails: see review R3. Remove .fails after repairing the planner.
it("R3: a group with no selected questions must not starve another group's recurring issue", async () => {
  const owner = await h.login("writer@example.test"),
    first = await h.group(owner),
    second = await h.group(owner),
    stamp = Date.now();
  await h.db
    .prepare("UPDATE questions SET selected=0 WHERE group_id=?")
    .bind(first)
    .run();
  await h.db
    .prepare("UPDATE groups SET next_delivery=? WHERE id=?")
    .bind(stamp + DAY, first)
    .run();
  await h.db
    .prepare("UPDATE groups SET next_delivery=? WHERE id=?")
    .bind(stamp + 2 * DAY, second)
    .run();
  for (let i = 0; i < 4; i++) await runScheduler(h.env, stamp + i);
  expect(
    await h.db
      .prepare("SELECT COUNT(*) AS n FROM issues WHERE group_id=?")
      .bind(second)
      .first(),
  ).toEqual({ n: 1 });
});
