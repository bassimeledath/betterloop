import { it, expect } from "vitest";
import { harness } from "./harness";
import { runScheduler } from "../server/scheduler";
import { runStages } from "../server/cron";
it("configures a bounded future policy, snapshots it, and deduplicates multiple reminder slots", async () => {
  const h = await harness();
  try {
    const owner = await h.login("owner@example.test"),
      gid = await h.group(owner),
      stamp = Date.now();
    const set = (hours: number[]) =>
      h.request(`/api/groups/${gid}/reminders`, {
        method: "PATCH",
        client: owner,
        body: { hours },
      });
    expect((await set([48, 24])).status).toBe(200);
    for (const bad of [[1, 1], [0], [1, 2, 3, 4]])
      expect((await set(bad)).status).toBe(400);
    const issue = await h.issue(owner, gid);
    const row = await h.db
      .prepare("SELECT reminder_offsets_json FROM issues WHERE id=?")
      .bind(issue.id)
      .first();
    expect(row).toEqual({ reminder_offsets_json: "[48,24]" });
    await set([]);
    const deadline = stamp + 4 * 86400000;
    await h.db
      .prepare(
        "UPDATE issues SET deadline=?,delivery_at=?,reminder_at=? WHERE id=?",
      )
      .bind(deadline, deadline, deadline - 48 * 3600000, issue.id)
      .run();
    await runScheduler(h.env, stamp);
    await runScheduler(h.env, deadline - 48 * 3600000);
    await runScheduler(h.env, deadline - 48 * 3600000);
    expect(
      await h.db
        .prepare(
          "SELECT COUNT(*) n FROM email_outbox WHERE kind='reminder' AND issue_id=?",
        )
        .bind(issue.id)
        .first(),
    ).toEqual({ n: 1 });
    await runScheduler(h.env, deadline - 24 * 3600000);
    await runScheduler(h.env, deadline - 24 * 3600000);
    expect(
      await h.db
        .prepare(
          "SELECT COUNT(*) n FROM email_outbox WHERE kind='reminder' AND issue_id=?",
        )
        .bind(issue.id)
        .first(),
    ).toEqual({ n: 2 });
  } finally {
    await h.close();
  }
});
it("continues mail after an independent stage fails and records stage health", async () => {
  const ran: string[] = [],
    health: Record<string, boolean> = {};
  expect(
    await runStages(
      {
        schedule: async () => {
          throw new Error("unavailable");
        },
        mail: async () => {
          ran.push("mail");
        },
        cleanup: async () => {
          throw new Error("R2");
        },
      },
      async (n, ok) => {
        health[n] = ok;
      },
    ),
  ).toBe(false);
  expect(ran).toEqual(["mail"]);
  expect(health).toEqual({ schedule: false, mail: true, cleanup: false });
});

it("skips obsolete reminder slots after downtime and respects a no-reminder policy", async () => {
  const h = await harness();
  try {
    const owner = await h.login("owner@example.test"),
      gid = await h.group(owner),
      stamp = Date.now();
    await h.request(`/api/groups/${gid}/reminders`, {
      method: "PATCH",
      client: owner,
      body: { hours: [72, 48, 24] },
    });
    const issue = await h.issue(owner, gid),
      deadline = stamp + 4 * 86400000;
    await h.db
      .prepare(
        "UPDATE issues SET deadline=?,delivery_at=?,reminder_at=? WHERE id=?",
      )
      .bind(deadline, deadline, deadline - 72 * 3600000, issue.id)
      .run();
    await runScheduler(h.env, stamp);
    await runScheduler(h.env, deadline - 12 * 3600000);
    await runScheduler(h.env, deadline - 11 * 3600000);
    expect(
      await h.db
        .prepare(
          "SELECT COUNT(*) n FROM email_outbox WHERE issue_id=? AND kind='reminder'",
        )
        .bind(issue.id)
        .first(),
    ).toEqual({ n: 1 });
    await h.db
      .prepare("UPDATE issues SET state='cancelled' WHERE id=?")
      .bind(issue.id)
      .run();
    await h.request(`/api/groups/${gid}/reminders`, {
      method: "PATCH",
      client: owner,
      body: { hours: [] },
    });
    const next = await h.issue(owner, gid);
    await runScheduler(h.env);
    await runScheduler(h.env);
    expect(
      await h.db
        .prepare(
          "SELECT COUNT(*) n FROM email_outbox WHERE issue_id=? AND kind='reminder'",
        )
        .bind(next.id)
        .first(),
    ).toEqual({ n: 0 });
  } finally {
    await h.close();
  }
});

it("runs the scheduled pipeline through a cleanup R2 failure while delivering queued mail", async () => {
  const { runCron } = await import("../server/cron");
  const { randomUUID } = await import("node:crypto");
  const h = await harness();
  try {
    const owner = await h.login("owner@example.test"),
      gid = await h.group(owner),
      issue = await h.issue(owner, gid);
    await h.db
      .prepare(
        "INSERT INTO assets(id,group_id,issue_id,user_id,object_key,content_type,bytes,width,height,state,created_at) VALUES(?,?,?,?,?,'image/jpeg',1,1,1,'deleting',?)",
      )
      .bind(
        randomUUID(),
        gid,
        issue.id,
        owner.id,
        "cleanup-fixture",
        Date.now(),
      )
      .run();
    await h.request("/api/auth/request", {
      method: "POST",
      body: { email: owner.email },
      headers: { "CF-Connecting-IP": owner.email },
    });
    const count = await h.db
      .prepare("SELECT COUNT(*) n FROM captured_emails")
      .first<{ n: number }>();
    const photos = new Proxy(h.bucket, {
      get(target, key) {
        if (key === "delete")
          return async () => {
            throw new Error("R2 unavailable");
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await runCron({ ...h.env, PHOTOS: photos });
    expect(
      (await h.db
        .prepare("SELECT COUNT(*) n FROM captured_emails")
        .first<{ n: number }>())!.n,
    ).toBeGreaterThan(count!.n);
    expect(
      await h.db
        .prepare("SELECT value FROM service_state WHERE key='cron:cleanup'")
        .first(),
    ).toEqual({ value: "failed" });
    expect(
      await h.db
        .prepare("SELECT value FROM service_state WHERE key='cron:mail'")
        .first(),
    ).toEqual({ value: "ok" });
  } finally {
    await h.close();
  }
});
