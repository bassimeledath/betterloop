import { afterEach, beforeEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { harness } from "./harness";
import { runExportStep } from "../server/exports";
import { runScheduler } from "../server/scheduler";
import { processOutbox } from "../server/mail";
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
}, 30000);
afterEach(async () => {
  await h.close();
});
const groupRequest = (requestId: string) => ({
  requestId,
  name: "A retried group",
  description: "A private circle",
  timezone: "America/Los_Angeles",
  cadence: "monthly",
  recurrence: { day: 3, hour: 17, minute: 0, weekday: 7 },
});
const tinyJpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1,
  0, 0, 63, 0, 12, 13, 255, 217,
]);
async function uploadFixturePhoto(
  owner: Awaited<ReturnType<typeof h.login>>,
  gid: string,
  iid: string,
) {
  const r = await h.request(
    "/api/groups/" + gid + "/issues/" + iid + "/assets",
    {
      method: "POST",
      client: owner,
      headers: { "Content-Type": "image/jpeg" },
      raw: tinyJpeg,
    },
  );
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
it("counts UTF-8 caption bytes in the total text limit and retains the saved draft after rejection", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid),
    aid = await uploadFixturePhoto(owner, gid, issue.id),
    path = "/api/groups/" + gid + "/issues/" + issue.id;
  const update = {
    answers: { [issue.qid]: "a".repeat(9500) },
    photos: [{ id: aid, caption: "🦆".repeat(125) }],
    shoutout: "",
    good: "",
  };
  expect(
    (
      await h.request(path + "/contribution", {
        method: "PUT",
        client: owner,
        body: { revision: 0, update },
      })
    ).status,
  ).toBe(200);
  const tooLong = { ...update, answers: { [issue.qid]: "a".repeat(9501) } };
  expect(
    (
      await h.request(path + "/contribution", {
        method: "PUT",
        client: owner,
        body: { revision: 1, update: tooLong },
      })
    ).status,
  ).toBe(413);
  const record = await h.db
    .prepare(
      "SELECT draft_json,revision FROM contributions WHERE issue_id=? AND user_id=?",
    )
    .bind(issue.id, owner.id)
    .first<{ draft_json: string; revision: number }>();
  expect(record!.revision).toBe(1);
  expect(JSON.parse(record!.draft_json)).toEqual(update);
  const unicode = "\uFEFFनमस्ते 👩🏽‍💻\nSecond\tline\r\n";
  expect(
    (
      await h.request(path + "/contribution", {
        method: "PUT",
        client: owner,
        body: {
          revision: 1,
          update: { ...update, answers: { [issue.qid]: unicode } },
        },
      })
    ).status,
  ).toBe(200);
  expect(
    JSON.parse(
      (await h.db
        .prepare(
          "SELECT draft_json FROM contributions WHERE issue_id=? AND user_id=?",
        )
        .bind(issue.id, owner.id)
        .first<{ draft_json: string }>())!.draft_json,
    ).answers[issue.qid],
  ).toBe(unicode);
});
it("rejects hidden controls and malformed Unicode before storing an update", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid),
    path = "/api/groups/" + gid + "/issues/" + issue.id;
  for (const update of [
    {
      answers: { [issue.qid]: "hidden\u0000text" },
      photos: [],
      shoutout: "",
      good: "",
    },
    {
      answers: { [issue.qid]: "\ud83d" },
      photos: [],
      shoutout: "",
      good: "\ude00",
    },
    {
      answers: {},
      photos: [{ id: randomUUID(), caption: "hidden\u0008caption" }],
      shoutout: "",
      good: "",
    },
  ]) {
    const r = await h.request(path + "/contribution", {
      method: "PUT",
      client: owner,
      body: { revision: 0, update },
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain(
      "control characters",
    );
  }
  expect(
    (await h.db
      .prepare("SELECT COUNT(*) AS n FROM contributions WHERE issue_id=?")
      .bind(issue.id)
      .first<{ n: number }>())!.n,
  ).toBe(0);
});
it("publishes twenty maximum-size escaped updates inside the bounded snapshot size", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid),
    stamp = Date.now();
  const questions = (
    await h.db
      .prepare(
        "SELECT id FROM issue_questions WHERE issue_id=? ORDER BY position",
      )
      .bind(issue.id)
      .all<{ id: string }>()
  ).results.map((q) => q.id);
  const statements = [
    h.db
      .prepare("UPDATE groups SET name=? WHERE id=?")
      .bind("\u0000".repeat(80), gid),
    h.db
      .prepare("UPDATE issues SET title=? WHERE id=?")
      .bind("\u0000".repeat(120), issue.id),
    h.db
      .prepare("UPDATE users SET name=? WHERE id=?")
      .bind("\u0000".repeat(80), owner.id),
  ];
  for (let n = questions.length; n < 10; n++) {
    const qid = randomUUID();
    questions.push(qid);
    statements.push(
      h.db
        .prepare(
          "INSERT INTO issue_questions(id,issue_id,group_id,text,author_name,position,author_id) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          qid,
          issue.id,
          gid,
          "\u0000".repeat(500),
          "\u0000".repeat(80),
          n,
          owner.id,
        ),
    );
  }
  statements.push(
    h.db
      .prepare(
        "UPDATE issue_questions SET text=?,author_name=? WHERE issue_id=?",
      )
      .bind("\u0000".repeat(500), "\u0000".repeat(80), issue.id),
  );
  let ownUpdate;
  for (let person = 0; person < 20; person++) {
    const uid = person === 0 ? owner.id : randomUUID();
    if (person) {
      statements.push(
        h.db
          .prepare(
            "INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)",
          )
          .bind(
            uid,
            "max-" + person + "@example.test",
            "\u0000".repeat(80),
            stamp,
          ),
        h.db
          .prepare(
            "INSERT INTO memberships(group_id,user_id,role,joined_at) VALUES(?,?,'member',?)",
          )
          .bind(gid, uid, stamp + person),
      );
    }
    const photos = [];
    for (let n = 0; n < 3; n++) {
      const aid = randomUUID();
      photos.push({ id: aid, caption: '"'.repeat(250) });
      statements.push(
        h.db
          .prepare(
            "INSERT INTO assets(id,group_id,issue_id,user_id,object_key,content_type,bytes,width,height,state,created_at) VALUES(?,?,?,?,?,'image/jpeg',29,1,1,'ready',?)",
          )
          .bind(aid, gid, issue.id, uid, aid, stamp),
      );
    }
    const update = {
      answers: Object.fromEntries(questions.map((q) => [q, '"'.repeat(925)])),
      photos,
      shoutout: "",
      good: "",
    };
    if (person === 0) ownUpdate = update;
    else
      statements.push(
        h.db
          .prepare(
            "INSERT INTO contributions(issue_id,group_id,user_id,draft_json,submitted_json,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?)",
          )
          .bind(
            issue.id,
            gid,
            uid,
            JSON.stringify(update),
            JSON.stringify(update),
            stamp,
            stamp,
          ),
      );
  }
  await h.db.batch(statements);
  const path = "/api/groups/" + gid + "/issues/" + issue.id;
  expect(
    (
      await h.request(path + "/contribution", {
        method: "PUT",
        client: owner,
        body: { revision: 0, update: ownUpdate },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.request(path + "/submit", {
        method: "POST",
        client: owner,
        body: { revision: 1 },
      })
    ).status,
  ).toBe(200);
  await h.db
    .prepare("UPDATE issues SET deadline=? WHERE id=?")
    .bind(Date.now() - 1, issue.id)
    .run();
  await runScheduler(h.env);
  const published = await h.db
    .prepare("SELECT content_json FROM publications WHERE issue_id=?")
    .bind(issue.id)
    .first<{ content_json: string }>();
  expect(published).not.toBeNull();
  expect(
    new TextEncoder().encode(published!.content_json).byteLength,
  ).toBeLessThan(500000);
  const snapshot = JSON.parse(published!.content_json);
  expect(snapshot.groupName).toHaveLength(80);
  expect(snapshot.title).toHaveLength(120);
  expect(snapshot.questions[0].text).toHaveLength(500);
  expect(snapshot.contributors[0].name).toHaveLength(80);
  expect(snapshot.contributors).toHaveLength(20);
});
it("creates one group, membership, starter set, and audit event for concurrent retries at the capacity limit", async () => {
  const owner = await h.login("owner@example.test"),
    body = groupRequest(randomUUID());
  await h.db
    .prepare("UPDATE users SET group_allowance=1 WHERE id=?")
    .bind(owner.id)
    .run();
  const responses = await Promise.all([
    h.request("/api/groups", { method: "POST", client: owner, body }),
    h.request("/api/groups", { method: "POST", client: owner, body }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
  const ids = await Promise.all(
    responses.map(async (r) => ((await r.json()) as { id: string }).id),
  );
  expect(ids[0]).toBe(ids[1]);
  const repeated = await h.request("/api/groups", {
    method: "POST",
    client: owner,
    body,
  });
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual({ id: ids[0] });
  const counts = await h.db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM groups WHERE owner_id=?) AS groups_count,(SELECT COUNT(*) FROM memberships WHERE group_id=?) AS members_count,(SELECT COUNT(*) FROM questions WHERE group_id=?) AS questions_count,(SELECT COUNT(*) FROM audit_events WHERE group_id=? AND action='group.created') AS audits_count",
    )
    .bind(owner.id, ids[0], ids[0], ids[0])
    .first();
  expect(counts).toEqual({
    groups_count: 1,
    members_count: 1,
    questions_count: 0,
    audits_count: 1,
  });
  expect(
    (
      await h.request("/api/groups", {
        method: "POST",
        client: owner,
        body: groupRequest(randomUUID()),
      })
    ).status,
  ).toBe(403);
});
it("scopes creation keys to their author and does not recreate a deleted group on replay", async () => {
  const a = await h.login("a@example.test"),
    b = await h.login("b@example.test"),
    body = groupRequest(randomUUID());
  const first = await h.request("/api/groups", {
      method: "POST",
      client: a,
      body,
    }),
    second = await h.request("/api/groups", {
      method: "POST",
      client: b,
      body,
    });
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const aid = ((await first.json()) as { id: string }).id,
    bid = ((await second.json()) as { id: string }).id;
  expect(aid).not.toBe(bid);
  expect(
    (
      await h.request("/api/groups/" + aid, {
        method: "DELETE",
        client: a,
        body: { name: body.name },
      })
    ).status,
  ).toBe(200);
  expect(
    (await h.request("/api/groups", { method: "POST", client: a, body }))
      .status,
  ).toBe(409);
  expect((await h.request("/api/groups/" + bid, { client: a })).status).toBe(
    404,
  );
});
it("throttles repeated upload attempts without blocking another group member", async () => {
  const owner = await h.login("owner@example.test"),
    friend = await h.login("friend@example.test"),
    gid = await h.group(owner);
  await h.invite(owner, friend, gid);
  const issue = await h.issue(owner, gid),
    path = "/api/groups/" + gid + "/issues/" + issue.id + "/assets";
  for (let n = 0; n < 12; n++)
    expect(
      (
        await h.request(path, {
          method: "POST",
          client: owner,
          headers: { "Content-Type": "image/jpeg" },
          raw: new Uint8Array([0]),
        })
      ).status,
    ).toBe(400);
  const jpeg = new Uint8Array([
    255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1,
    0, 0, 63, 0, 12, 13, 255, 217,
  ]);
  expect(
    (
      await h.request(path, {
        method: "POST",
        client: owner,
        headers: { "Content-Type": "image/jpeg" },
        raw: jpeg,
      })
    ).status,
  ).toBe(429);
  expect(
    (
      await h.request(path, {
        method: "POST",
        client: friend,
        headers: { "Content-Type": "image/jpeg" },
        raw: jpeg,
      })
    ).status,
  ).toBe(201);
  expect(
    (await h.db
      .prepare("SELECT COUNT(*) AS n FROM assets WHERE user_id=?")
      .bind(owner.id)
      .first<{ n: number }>())!.n,
  ).toBe(0);
});
it("includes the selected questions and current group-timezone deadline in opening mail", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid);
  await h.db.batch([
    h.db
      .prepare("UPDATE groups SET timezone='Pacific/Auckland' WHERE id=?")
      .bind(gid),
    h.db
      .prepare("UPDATE issue_questions SET text=? WHERE id=?")
      .bind("Where <next> & why?", issue.qid),
    h.db
      .prepare("UPDATE issues SET deadline=? WHERE id=?")
      .bind(Date.UTC(2030, 0, 1, 12, 30), issue.id),
  ]);
  await runScheduler(h.env);
  const detail = await h.request("/api/groups/" + gid + "/issues/" + issue.id, {
    client: owner,
  });
  expect(
    ((await detail.json()) as { issue: { timezone: string } }).issue.timezone,
  ).toBe("Pacific/Auckland");
  // An extension after enqueueing must appear in the eventual email.
  await h.db
    .prepare("UPDATE issues SET deadline=? WHERE id=?")
    .bind(Date.UTC(2030, 0, 1, 13, 30), issue.id)
    .run();
  await processOutbox(h.env);
  const mail = await h.db
    .prepare(
      "SELECT html,text FROM captured_emails WHERE recipient=? AND subject LIKE '%time for a little update%' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(owner.email)
    .first<{ html: string; text: string }>();
  expect(mail).not.toBeNull();
  expect(mail!.text).toContain("Where <next> & why?");
  expect(mail!.html).toContain("Where &lt;next&gt; &amp; why?");
  expect(mail!.text).toContain("Jan 2, 2030");
  expect(mail!.text).toContain("2:30 AM");
  expect(mail!.text).toContain("Pacific/Auckland");
  expect(mail!.html).toContain("Answers due");
  expect(mail!.text).toContain("/groups/" + gid + "/issues/" + issue.id);
  expect(mail!.html).toContain("/groups/" + gid + "/preferences");
});
it("retries definite provider rejections at most five times, then records a known failure", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid);
  await runScheduler(h.env);
  let sends = 0;
  const env = {
    ...h.env,
    EMAIL_MODE: "live" as const,
    EMAIL_FROM: "sender@example.test",
    EMAIL: {
      send: async (message: {
        from: string | { email: string; name: string };
        subject: string;
      }) => {
        expect(message.from).toEqual({
          email: "sender@example.test",
          name: "Betterloop",
        });
        expect(message.subject).toBe(
          "Betterloop · Test circle: time for a little update",
        );
        sends++;
        throw Object.assign(new Error("Explicit rejection"), {
          code: "E_RATE_LIMITED",
        });
      },
    },
  };
  for (let n = 1; n <= 5; n++) {
    await processOutbox(env);
    const row = await h.db
      .prepare(
        "SELECT attempts,state,error_code FROM email_outbox WHERE issue_id=? AND kind='opening'",
      )
      .bind(issue.id)
      .first();
    expect(row).toMatchObject({
      attempts: n,
      state: n < 5 ? "queued" : "failed",
      error_code: "E_RATE_LIMITED",
    });
    await h.db
      .prepare("UPDATE email_outbox SET next_attempt=0 WHERE issue_id=?")
      .bind(issue.id)
      .run();
  }
  await processOutbox(env);
  expect(sends).toBe(5);
});
it("stops a queued notification after the twenty-four-hour delivery window", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid);
  await runScheduler(h.env);
  await h.db
    .prepare("UPDATE email_outbox SET created_at=? WHERE issue_id=?")
    .bind(Date.now() - 86400001, issue.id)
    .run();
  let sends = 0;
  await processOutbox({
    ...h.env,
    EMAIL_MODE: "live",
    EMAIL_FROM: "sender@example.test",
    EMAIL: {
      send: async () => {
        sends++;
        return { messageId: "unused" };
      },
    },
  });
  expect(sends).toBe(0);
  expect(
    await h.db
      .prepare(
        "SELECT state,error_code FROM email_outbox WHERE issue_id=? AND kind='opening'",
      )
      .bind(issue.id)
      .first(),
  ).toMatchObject({ state: "failed", error_code: "delivery_window_expired" });
});
it("replaces earlier ownership requests and prevents their revival after ownership returns", async () => {
  const a = await h.login("a@example.test"),
    b = await h.login("b@example.test"),
    c = await h.login("c@example.test"),
    gid = await h.group(a);
  await h.invite(a, b, gid);
  await h.invite(a, c, gid);
  const request = async (owner: typeof a, target: typeof a) => {
    const r = await h.request("/api/groups/" + gid + "/transfers", {
      method: "POST",
      client: owner,
      body: { userId: target.id },
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { id: string }).id;
  };
  const old = await request(a, c),
    current = await request(a, b);
  expect(
    (
      await h.request("/api/groups/" + gid + "/transfers/" + old + "/accept", {
        method: "POST",
        client: c,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await h.request(
        "/api/groups/" + gid + "/transfers/" + current + "/accept",
        { method: "POST", client: b },
      )
    ).status,
  ).toBe(200);
  const back = await request(b, a);
  expect(
    (
      await h.request("/api/groups/" + gid + "/transfers/" + back + "/accept", {
        method: "POST",
        client: a,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.request("/api/groups/" + gid + "/transfers/" + old + "/accept", {
        method: "POST",
        client: c,
      })
    ).status,
  ).toBe(404);
});
it("requires a new admin appointment when a removed administrator rejoins", async () => {
  const owner = await h.login("owner@example.test"),
    friend = await h.login("friend@example.test"),
    gid = await h.group(owner);
  await h.invite(owner, friend, gid);
  const path = "/api/groups/" + gid + "/members/" + friend.id;
  expect(
    (
      await h.request(path, {
        method: "PATCH",
        client: owner,
        body: { role: "admin" },
      })
    ).status,
  ).toBe(200);
  expect(
    (await h.request(path, { method: "DELETE", client: owner })).status,
  ).toBe(200);
  await h.invite(owner, friend, gid);
  const m = await h.db
    .prepare("SELECT role FROM memberships WHERE group_id=? AND user_id=?")
    .bind(gid, friend.id)
    .first<{ role: string }>();
  expect(m!.role).toBe("member");
  expect(
    (
      await h.request("/api/groups/" + gid + "/pause", {
        method: "POST",
        client: friend,
        body: { paused: true },
      })
    ).status,
  ).toBe(403);
});
it("runs two recurring cycles and publishes each submitted snapshot exactly once", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    start = Date.now();
  const rule = { day: 3, hour: 17, minute: 0, weekday: 7 };
  await h.db
    .prepare(
      "UPDATE groups SET cadence='weekly',recurrence_json=?,next_delivery=? WHERE id=?",
    )
    .bind(JSON.stringify(rule), start + 86400000, gid)
    .run();
  let clock = start;
  for (let n = 0; n < 2; n++) {
    await runScheduler(h.env, clock);
    await runScheduler(h.env, clock);
    const issue = await h.db
      .prepare(
        "SELECT id,deadline FROM issues WHERE group_id=? AND state='open'",
      )
      .bind(gid)
      .first<{ id: string; deadline: number }>();
    expect(issue).toBeTruthy();
    const path = "/api/groups/" + gid + "/issues/" + issue!.id;
    const saved = await h.request(path + "/contribution", {
      method: "PUT",
      client: owner,
      body: {
        revision: 0,
        update: {
          answers: {},
          photos: [],
          shoutout: "Cycle " + (n + 1),
          good: "Something to remember.",
        },
      },
    });
    expect(saved.status).toBe(200);
    const revision = ((await saved.json()) as { revision: number }).revision;
    expect(
      (
        await h.request(path + "/submit", {
          method: "POST",
          client: owner,
          body: { revision },
        })
      ).status,
    ).toBe(200);
    clock = issue!.deadline + 1;
    await runScheduler(h.env, clock);
    await runScheduler(h.env, clock);
  }
  const publications = await h.db
    .prepare("SELECT content_json FROM publications WHERE group_id=?")
    .bind(gid)
    .all<{ content_json: string }>();
  expect(publications.results).toHaveLength(2);
  expect(
    publications.results
      .map((p) => JSON.parse(p.content_json).contributors[0].update.shoutout)
      .sort(),
  ).toEqual(["Cycle 1", "Cycle 2"]);
  expect(
    (await h.db
      .prepare(
        "SELECT COUNT(*) n FROM email_outbox WHERE group_id=? AND kind='publication'",
      )
      .bind(gid)
      .first<{ n: number }>())!.n,
  ).toBe(2);
});
it("paginates the whole private archive with a group-bound cursor", async () => {
  const owner = await h.login("owner@example.test"),
    stranger = await h.login("stranger@example.test"),
    gid = await h.group(owner),
    other = await h.group(stranger);
  for (let n = 0; n < 23; n++)
    await h.db
      .prepare(
        "INSERT INTO issues(id,group_id,title,opens_at,deadline,delivery_at,state,reminder_at,created_at) VALUES(?,?,?,0,?,?,'published',0,0)",
      )
      .bind(randomUUID(), gid, "Issue " + n, n + 1, n + 1)
      .run();
  const first = (await (
    await h.request("/api/groups/" + gid + "/archive", { client: owner })
  ).json()) as { issues: { id: string; title: string }[]; next: string };
  expect(first.issues).toHaveLength(20);
  expect(first.issues[0].title).toBe("Issue 22");
  const second = (await (
    await h.request("/api/groups/" + gid + "/archive?before=" + first.next, {
      client: owner,
    })
  ).json()) as { issues: { id: string; title: string }[]; next: null };
  expect(second.issues).toHaveLength(3);
  expect(second.next).toBeNull();
  expect(
    new Set([...first.issues, ...second.issues].map((i) => i.id)).size,
  ).toBe(23);
  expect(
    (
      await h.request(
        "/api/groups/" + other + "/archive?before=" + first.next,
        { client: stranger },
      )
    ).status,
  ).toBe(400);
  expect(
    (await h.request("/api/groups/" + gid + "/archive", { client: stranger }))
      .status,
  ).toBe(404);
});
it("does not send a reminder after submission, opt-out, or removal", async () => {
  const owner = await h.login("owner@example.test"),
    friend = await h.login("friend@example.test"),
    removed = await h.login("removed@example.test"),
    gid = await h.group(owner);
  await h.invite(owner, friend, gid);
  await h.invite(owner, removed, gid);
  const issue = await h.issue(owner, gid);
  await runScheduler(h.env);
  await processOutbox(h.env, 20);
  await h.db
    .prepare("UPDATE issues SET reminder_at=? WHERE id=?")
    .bind(Date.now() - 1, issue.id)
    .run();
  await h.db
    .prepare(
      "INSERT INTO contributions(issue_id,group_id,user_id,submitted_json,submitted_at,updated_at) VALUES(?,?,?,'{}',?,?)",
    )
    .bind(issue.id, gid, owner.id, Date.now(), Date.now())
    .run();
  await runScheduler(h.env);
  await h.request("/api/groups/" + gid + "/preferences", {
    method: "PATCH",
    client: friend,
    body: { opening: true, reminder: false, publication: true },
  });
  await h.request("/api/groups/" + gid + "/members/" + removed.id, {
    method: "DELETE",
    client: owner,
  });
  await processOutbox(h.env, 20);
  expect(
    (await h.db
      .prepare(
        "SELECT COUNT(*) n FROM captured_emails WHERE subject LIKE '%reminder%'",
      )
      .first<{ n: number }>())!.n,
  ).toBe(0);
  const queued = await h.db
    .prepare("SELECT user_id,state FROM email_outbox WHERE kind='reminder'")
    .all<{ user_id: string; state: string }>();
  expect(queued.results.some((r) => r.user_id === owner.id)).toBe(false);
  expect(queued.results.every((r) => r.state === "skipped")).toBe(true);
});
it("assembles a multipart export larger than five MiB without changing any photo bytes", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid),
    photos = [] as { id: string; caption: string }[];
  for (let n = 0; n < 6; n++) {
    const aid = randomUUID(),
      bytes = new Uint8Array(1024 * 1024).fill(n + 1);
    await h.bucket.put("fixture/" + aid, bytes);
    await h.db
      .prepare(
        "INSERT INTO assets(id,group_id,issue_id,user_id,object_key,content_type,bytes,width,height,state,created_at) VALUES(?,?,?,?,?,'image/jpeg',1048576,1,1,'ready',?)",
      )
      .bind(aid, gid, issue.id, owner.id, "fixture/" + aid, Date.now())
      .run();
    photos.push({ id: aid, caption: "" });
  }
  // Two retained sets exercise export assembly, independently of the three-photo upload UI.
  const update = (p: typeof photos) =>
    JSON.stringify({ answers: {}, photos: p, shoutout: "", good: "" });
  await h.db
    .prepare(
      "INSERT INTO contributions(issue_id,group_id,user_id,draft_json,submitted_json,updated_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(
      issue.id,
      gid,
      owner.id,
      update(photos.slice(0, 3)),
      update(photos.slice(3)),
      Date.now(),
    )
    .run();
  const created = await h.request("/api/me/exports", {
    method: "POST",
    client: owner,
  });
  const jid = ((await created.json()) as { id: string }).id;
  for (let n = 0; n < 20; n++) await runExportStep(h.env);
  const job = await h.db
    .prepare("SELECT state,parts_json FROM exports WHERE id=?")
    .bind(jid)
    .first<{ state: string; parts_json: string }>();
  expect(job!.state).toBe("ready");
  expect(JSON.parse(job!.parts_json)).toHaveLength(2);
  const bytes = new Uint8Array(
    await (
      await h.request("/api/exports/" + jid + "/download", { client: owner })
    ).arrayBuffer(),
  );
  let at = 0,
    photoCount = 0;
  while (bytes[at]) {
    const name = new TextDecoder()
        .decode(bytes.slice(at, at + 100))
        .split("\0")[0],
      size = parseInt(
        new TextDecoder().decode(bytes.slice(at + 124, at + 136)),
        8,
      );
    if (name.startsWith("photos/")) {
      const photo = photos.findIndex((p) => name.includes(p.id));
      expect(size).toBe(1048576);
      expect(
        bytes.slice(at + 512, at + 512 + size).every((v) => v === photo + 1),
      ).toBe(true);
      photoCount++;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  expect(photoCount).toBe(6);
  expect(at + 1024).toBe(bytes.length);
}, 30000);
