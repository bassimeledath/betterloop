import { it, expect } from "vitest";
import { harness } from "./harness";
import { runCleanup } from "../server/cleanup";
it("does not spend durable audit writes on rejected anonymous requests", async () => {
  const h = await harness();
  try {
    expect((await h.request("/api/groups")).status).toBe(401);
    expect(
      (
        await h.request("/api/groups", {
          method: "POST",
          body: { name: "untrusted" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.request("/api/auth/request", {
          method: "POST",
          body: { email: "not-an-address" },
        })
      ).status,
    ).toBe(400);
    expect(
      await h.db.prepare("SELECT COUNT(*) AS n FROM audit_events").first(),
    ).toEqual({ n: 0 });
  } finally {
    await h.close();
  }
}, 30000);
it("executes a scheduled event before the first HTTP request, then serves the authenticated app", async () => {
  const h = await harness();
  try {
    const worker = await h.mf.getWorker();
    const result = await worker.scheduled({
      cron: "* * * * *",
      scheduledTime: new Date(),
    });
    expect(result.outcome).toBe("ok");
    expect(
      (
        await h.db
          .prepare("SELECT value FROM service_state WHERE key='cron'")
          .first<{ value: string }>()
      )?.value,
    ).toBe("ok");
    const owner = await h.login("host@example.test", true),
      gid = await h.group(owner),
      issue = await h.issue(owner, gid);
    const path = "/api/groups/" + gid + "/issues/" + issue.id;
    const saved = await h.request(path + "/contribution", {
      method: "PUT",
      client: owner,
      body: {
        revision: 0,
        update: {
          answers: {},
          photos: [],
          shoutout: "A scheduled letter",
          good: "",
        },
      },
    });
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
    await h.db
      .prepare("UPDATE issues SET deadline=? WHERE id=?")
      .bind(Date.now() - 1, issue.id)
      .run();
    expect(
      (await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date() }))
        .outcome,
    ).toBe("ok");
    expect(
      (
        await h.db
          .prepare("SELECT content_json FROM publications WHERE issue_id=?")
          .bind(issue.id)
          .first<{ content_json: string }>()
      )?.content_json,
    ).toContain("A scheduled letter");
    expect((await h.request(path, { client: owner })).status).toBe(200);
  } finally {
    await h.close();
  }
}, 30000);
it("records request timing and route identity without private bodies, URLs, cookies or headers", async () => {
  const h = await harness();
  try {
    const owner = await h.login("host@example.test", true),
      gid = await h.group(owner),
      issue = await h.issue(owner, gid);
    const response = await h.request(
      "/api/groups/" +
        gid +
        "/issues/" +
        issue.id +
        "/contribution?private=URL_CANARY",
      {
        method: "PUT",
        client: owner,
        headers: { "X-Private-Test": "HEADER_CANARY" },
        body: {
          revision: 0,
          update: {
            answers: { [issue.qid]: "ANSWER_CANARY" },
            photos: [],
            shoutout: "",
            good: "",
          },
        },
      },
    );
    expect(response.status).toBe(200);
    const requestId = response.headers.get("X-Request-ID");
    const event = await h.db
      .prepare(
        "SELECT actor_id,group_id,target,details_json FROM audit_events WHERE action='request.completed' AND json_extract(details_json,'$.requestId')=?",
      )
      .bind(requestId)
      .first<{
        actor_id: string;
        group_id: string;
        target: string;
        details_json: string;
      }>();
    expect(event).toMatchObject({
      actor_id: owner.id,
      group_id: gid,
      target: issue.id,
    });
    const details = JSON.parse(event!.details_json);
    expect(details).toMatchObject({
      requestId,
      operation: "PUT /api/groups/:groupId/issues/:issueId/contribution",
      status: 200,
      error_code: null,
    });
    expect(details.duration_ms).toBeGreaterThanOrEqual(0);
    for (const secret of [
      "ANSWER_CANARY",
      "URL_CANARY",
      "HEADER_CANARY",
      owner.cookie,
      owner.csrf,
    ])
      expect(JSON.stringify(event)).not.toContain(secret);
  } finally {
    await h.close();
  }
}, 30000);
it("commits state audits atomically, omits no-op transitions, and redacts unrecognized provider codes", async () => {
  const h = await harness();
  try {
    const owner = await h.login("host@example.test", true),
      gid = await h.group(owner),
      issue = await h.issue(owner, gid),
      stamp = Date.now();
    await expect(
      h.db.batch([
        h.db
          .prepare("UPDATE issues SET state='closing' WHERE id=?")
          .bind(issue.id),
        h.db
          .prepare(
            "INSERT INTO users(id,email,name,created_at) VALUES('duplicate',?,'Duplicate',?)",
          )
          .bind(owner.email, stamp),
      ]),
    ).rejects.toThrow();
    expect(
      await h.db
        .prepare("SELECT state FROM issues WHERE id=?")
        .bind(issue.id)
        .first(),
    ).toEqual({ state: "open" });
    expect(
      (
        await h.db
          .prepare(
            "SELECT id FROM audit_events WHERE action='issue.state_changed' AND target=?",
          )
          .bind(issue.id)
          .all()
      ).results,
    ).toHaveLength(0);
    await h.db
      .prepare("UPDATE issues SET state='closing' WHERE id=?")
      .bind(issue.id)
      .run();
    await h.db
      .prepare("UPDATE issues SET state='closing' WHERE id=?")
      .bind(issue.id)
      .run();
    const events = await h.db
      .prepare(
        "SELECT details_json FROM audit_events WHERE action='issue.state_changed' AND target=?",
      )
      .bind(issue.id)
      .all<{ details_json: string }>();
    expect(events.results.map((e) => JSON.parse(e.details_json))).toEqual([
      { from: "open", to: "closing" },
    ]);
    await h.db
      .prepare(
        "INSERT INTO email_outbox(id,logical_key,user_id,recipient,kind,next_attempt,created_at,updated_at) VALUES('redaction','redaction',?,?,'login',?,?,?)",
      )
      .bind(owner.id, owner.email, stamp, stamp, stamp)
      .run();
    await h.db
      .prepare(
        "UPDATE email_outbox SET state='uncertain',error_code='TOKEN_CANARY' WHERE id='redaction'",
      )
      .run();
    const mail = await h.db
      .prepare(
        "SELECT details_json FROM audit_events WHERE action='mail.state_changed' AND target='redaction'",
      )
      .first<{ details_json: string }>();
    expect(JSON.parse(mail!.details_json)).toEqual({
      from: "queued",
      to: "uncertain",
      error_code: "redacted_error",
    });
    await h.db
      .prepare(
        "INSERT INTO exports(id,user_id,kind,created_at,expires_at) VALUES('audit-export',?,'personal',?,?)",
      )
      .bind(owner.id, stamp, stamp + 3600000)
      .run();
    await h.db
      .prepare("UPDATE exports SET state='failed' WHERE id='audit-export'")
      .run();
    expect(
      JSON.parse(
        (await h.db
          .prepare(
            "SELECT details_json FROM audit_events WHERE action='export.state_changed' AND target='audit-export'",
          )
          .first<{ details_json: string }>())!.details_json,
      ),
    ).toEqual({ from: "planning", to: "failed" });
  } finally {
    await h.close();
  }
}, 30000);
it("retains recent operational events and removes those past thirty days", async () => {
  const h = await harness();
  try {
    const stamp = Date.now();
    for (const [id, age] of [
      ["old", 31],
      ["recent", 29],
    ] as const)
      await h.db
        .prepare(
          "INSERT INTO audit_events(id,action,created_at,details_json) VALUES(?,'request.completed',?,'{}')",
        )
        .bind(id, stamp - age * 86400000)
        .run();
    await runCleanup(h.env, stamp);
    expect(
      await h.db.prepare("SELECT id FROM audit_events WHERE id='old'").first(),
    ).toBeNull();
    expect(
      await h.db
        .prepare("SELECT id FROM audit_events WHERE id='recent'")
        .first(),
    ).toEqual({ id: "recent" });
  } finally {
    await h.close();
  }
}, 30000);
it("does not turn a committed group creation into failure when its request audit is unavailable", async () => {
  const h = await harness();
  try {
    const owner = await h.login("host@example.test", true);
    await h.db
      .prepare(
        "CREATE TRIGGER synthetic_audit_outage BEFORE INSERT ON audit_events WHEN NEW.action='request.completed' BEGIN SELECT RAISE(ABORT,'synthetic audit outage'); END",
      )
      .run();
    const gid = await h.group(owner);
    expect(
      await h.db.prepare("SELECT id FROM groups WHERE id=?").bind(gid).first(),
    ).toEqual({ id: gid });
    expect(
      (await h.db.prepare("SELECT id FROM groups").all()).results,
    ).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 30000);
it("keeps cloud backup status private to the operator and returns only summary metadata", async () => {
  const h = await harness();
  try {
    const owner = await h.login("host@example.test", true),
      member = await h.login("member@example.test");
    const stamp = Date.now();
    await h.backups.put(
      "index.json",
      JSON.stringify({
        format: "betterloop-backup-index-v1",
        snapshots: [
          {
            id: "private-snapshot-name",
            state: "ready",
            createdAt: stamp,
            bytes: 10288,
            chunks: [{ key: "snapshots/private/part-00001" }],
          },
        ],
      }),
    );
    expect((await h.request("/api/operator", { client: member })).status).toBe(
      403,
    );
    const r = await h.request("/api/operator", { client: owner });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      backups: {
        status: string;
        readyCount: number;
        bytes: number;
        lastReadyAt: number;
      };
    };
    expect(body.backups).toMatchObject({
      status: "ready",
      readyCount: 1,
      bytes: 10288,
      lastReadyAt: stamp,
    });
    expect(JSON.stringify(body.backups)).not.toContain("private-snapshot-name");
    expect(JSON.stringify(body.backups)).not.toContain("part-00001");
  } finally {
    await h.close();
  }
}, 30000);
it("shows the oldest eligible work without exposing drafts and audits operator access", async () => {
  const h = await harness();
  try {
    const owner = await h.login("host@example.test", true),
      friend = await h.login("friend@example.test"),
      gid = await h.group(owner),
      issue = await h.issue(owner, gid),
      stamp = Date.now();
    await h.db
      .prepare(
        "INSERT INTO contributions(issue_id,group_id,user_id,draft_json,updated_at) VALUES(?,?,?,json_object('answers',json_object('private','PRIVATE_DRAFT_CANARY'),'photos',json('[]'),'shoutout','','good',''),?)",
      )
      .bind(issue.id, gid, owner.id, stamp)
      .run();
    await h.db
      .prepare("UPDATE issues SET deadline=? WHERE id=?")
      .bind(stamp - 3600000, issue.id)
      .run();
    for (const [id, state, due] of [
      ["due", "queued", stamp - 1800000],
      ["later", "queued", stamp + 3600000],
      ["accepted", "accepted", stamp - 7200000],
    ] as const)
      await h.db
        .prepare(
          "INSERT INTO email_outbox(id,logical_key,user_id,recipient,kind,state,next_attempt,created_at,updated_at) VALUES(?,?,?,?,'opening',?,?,?,?)",
        )
        .bind(id, id, owner.id, owner.email, state, due, stamp - 7200000, stamp)
        .run();
    for (const [id, uid, state, expiry, lease] of [
      ["waiting", owner.id, "planning", stamp + 3600000, null],
      ["leased", friend.id, "building", stamp + 3600000, stamp + 120000],
      ["expired", owner.id, "planning", stamp - 1, null],
    ] as const)
      await h.db
        .prepare(
          "INSERT INTO exports(id,user_id,kind,state,created_at,expires_at,lease_until) VALUES(?,?,'personal',?,?,?,?)",
        )
        .bind(id, uid, state, stamp - 900000, expiry, lease)
        .run();
    expect((await h.request("/api/operator", { client: friend })).status).toBe(
      403,
    );
    const response = await h.request("/api/operator", { client: owner }),
      body = (await response.json()) as { dueWork: unknown };
    expect(response.status).toBe(200);
    expect(body.dueWork).toEqual({
      issues: { count: 1, oldest_at: stamp - 3600000 },
      emails: { count: 1, oldest_at: stamp - 1800000 },
      exports: { count: 1, oldest_at: stamp - 900000 },
    });
    expect(JSON.stringify(body)).not.toContain("PRIVATE_DRAFT_CANARY");
    expect(
      await h.db
        .prepare(
          "SELECT actor_id FROM audit_events WHERE action='operator.viewed'",
        )
        .all(),
    ).toMatchObject({ results: [{ actor_id: owner.id }] });
  } finally {
    await h.close();
  }
}, 30000);
it("does not mistake future or paused openings for an overdue publication", async () => {
  const h = await harness();
  try {
    const owner = await h.login("host@example.test", true),
      gid = await h.group(owner),
      issue = await h.issue(owner, gid),
      stamp = Date.now();
    const cases = [
      {
        state: "scheduled",
        paused: 0,
        opens: stamp + 3600000,
        deadline: stamp + 7200000,
        opened: false,
        reminded: null,
        count: 0,
        oldest: null,
      },
      {
        state: "scheduled",
        paused: 0,
        opens: stamp - 3600000,
        deadline: stamp + 7200000,
        opened: false,
        reminded: null,
        count: 1,
        oldest: stamp - 3600000,
      },
      {
        state: "scheduled",
        paused: 1,
        opens: stamp - 3600000,
        deadline: stamp + 7200000,
        opened: false,
        reminded: null,
        count: 0,
        oldest: null,
      },
      {
        state: "open",
        paused: 0,
        opens: stamp - 3600000,
        deadline: stamp + 7200000,
        opened: false,
        reminded: null,
        count: 1,
        oldest: stamp - 3600000,
      },
      {
        state: "open",
        paused: 0,
        opens: stamp - 3600000,
        deadline: stamp + 7200000,
        opened: true,
        reminded: null,
        count: 1,
        oldest: stamp - 1800000,
      },
      {
        state: "open",
        paused: 0,
        opens: stamp - 3600000,
        deadline: stamp + 7200000,
        opened: true,
        reminded: stamp - 60000,
        count: 0,
        oldest: null,
      },
      {
        state: "open",
        paused: 1,
        opens: stamp - 3600000,
        deadline: stamp - 60000,
        opened: true,
        reminded: null,
        count: 1,
        oldest: stamp - 60000,
      },
      {
        state: "closing",
        paused: 1,
        opens: stamp - 3600000,
        deadline: stamp - 60000,
        opened: true,
        reminded: null,
        count: 1,
        oldest: stamp - 60000,
      },
      {
        state: "published",
        paused: 0,
        opens: stamp - 3600000,
        deadline: stamp - 60000,
        opened: true,
        reminded: null,
        count: 0,
        oldest: null,
      },
    ];
    for (const c of cases) {
      await h.db
        .prepare("UPDATE groups SET paused=? WHERE id=?")
        .bind(c.paused, gid)
        .run();
      await h.db
        .prepare(
          "UPDATE issues SET state=?,opens_at=?,deadline=?,reminder_at=?,reminded_at=? WHERE id=?",
        )
        .bind(
          c.state,
          c.opens,
          c.deadline,
          stamp - 1800000,
          c.reminded,
          issue.id,
        )
        .run();
      await h.db
        .prepare("DELETE FROM service_state WHERE key=?")
        .bind("opened:" + issue.id)
        .run();
      if (c.opened)
        await h.db
          .prepare(
            "INSERT INTO service_state(key,value,updated_at) VALUES(?,'ok',?)",
          )
          .bind("opened:" + issue.id, stamp - 3600000)
          .run();
      const body = (await (
        await h.request("/api/operator", { client: owner })
      ).json()) as {
        dueWork: { issues: { count: number; oldest_at: number | null } };
      };
      expect(body.dueWork.issues, JSON.stringify(c)).toEqual({
        count: c.count,
        oldest_at: c.oldest,
      });
    }
  } finally {
    await h.close();
  }
}, 30000);
