import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { processOutbox } from "../server/mail";
import type { Env, Publication } from "../server/types";
let mf: Miniflare, db: D1Database;
const origin = "http://localhost";
type Client = { cookie: string; csrf: string; id: string };
async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    client?: Client;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = {
    Origin: origin,
    ...options.headers,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.client) {
    headers.Cookie = options.client.cookie;
    headers["X-CSRF-Token"] = options.client.csrf;
  }
  return mf.dispatchFetch(origin + path, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
async function login(email: string) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO users(id,email,name,operator,group_allowance,created_at) VALUES(?,?,?,0,5,?)",
    )
    .bind(webcrypto.randomUUID(), email, email.split("@")[0], Date.now())
    .run();
  await db
    .prepare(
      "INSERT OR REPLACE INTO email_destinations(email,verified,checked_at) VALUES(?,1,?)",
    )
    .bind(email, Date.now())
    .run();
  expect(
    (await request("/api/auth/request", { method: "POST", body: { email } }))
      .status,
  ).toBe(200);
  await request("/api/dev/tick", { method: "POST" });
  const mail = await db
    .prepare(
      "SELECT text FROM captured_emails WHERE recipient=? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(email)
    .first<{ text: string }>();
  expect(mail).toBeTruthy();
  const token = mail!.text.match(/#token=([a-f0-9]{64})/)![1];
  const r = await request("/api/auth/consume", {
    method: "POST",
    body: { token },
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { csrf: string };
  const user = await db
    .prepare("SELECT id FROM users WHERE email=?")
    .bind(email)
    .first<{ id: string }>();
  return {
    client: {
      cookie: r.headers.get("set-cookie")!.split(";")[0],
      csrf: body.csrf,
      id: user!.id,
    },
    token,
  };
}
const baseGroup = {
  name: "Our table",
  description: "A private monthly letter",
  timezone: "America/Los_Angeles",
  cadence: "monthly",
  recurrence: { day: 3, hour: 17, minute: 0, weekday: 7 },
};
async function newGroup(client: Client, name = "Our table") {
  const r = await request("/api/groups", {
    method: "POST",
    client,
    body: { ...baseGroup, name },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
beforeAll(async () => {
  await mkdir("work", { recursive: true });
  await build({
    entryPoints: ["server/index.ts"],
    outfile: "work/test-worker.mjs",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  mf = new Miniflare({
    modules: true,
    scriptPath: "work/test-worker.mjs",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
    r2Buckets: ["PHOTOS"],
    bindings: {
      ENVIRONMENT: "test",
      EMAIL_MODE: "capture",
      OPERATOR_EMAIL: "host@example.test",
      APP_ORIGIN: origin,
      OUTBOX_KEY: "integration-test-key",
    },
  });
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const file of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile("migrations/" + file, "utf8");
    for (const part of sql
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(part).run();
  }
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
describe("real Worker and D1 access boundaries", () => {
  it("requires a session and hides local helpers on non-local hosts", async () => {
    expect((await request("/api/groups")).status).toBe(401);
    expect(
      (await mf.dispatchFetch("https://letters.example.com/api/dev/inbox"))
        .status,
    ).toBe(404);
  });
  it("creates a session only after explicit confirmation and prevents token replay", async () => {
    const { client, token } = await login("first@example.test");
    expect((await request("/api/me", { client })).status).toBe(200);
    expect(
      (await request("/api/auth/consume", { method: "POST", body: { token } }))
        .status,
    ).toBe(400);
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=?")
        .bind(client.id)
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });
  it("rejects forgery and isolates groups, questions, and member details", async () => {
    const a = (await login("alice@example.test")).client,
      b = (await login("bob@example.test")).client;
    const ga = await newGroup(a, "Alice’s group"),
      gb = await newGroup(b, "Bob’s group");
    expect((await request("/api/groups/" + ga, { client: b })).status).toBe(
      404,
    );
    expect(
      (await request("/api/groups/" + ga + "/members", { client: b })).status,
    ).toBe(404);
    expect(
      (await request("/api/groups/" + gb + "/questions", { client: a })).status,
    ).toBe(404);
    const forgery = await request("/api/groups", {
      method: "POST",
      client: a,
      headers: { Origin: "https://attacker.example" },
      body: baseGroup,
    });
    expect(forgery.status).toBe(403);
  });
  it("ties an invitation to the invited address, then respects immediate removal", async () => {
    const owner = (await login("owner@example.test")).client,
      friend = (await login("friend@example.test")).client,
      stranger = (await login("stranger@example.test")).client;
    const g = await newGroup(owner, "Invitation group");
    const inv = await request("/api/groups/" + g + "/invitations", {
      method: "POST",
      client: owner,
      body: { email: "friend@example.test" },
    });
    expect(inv.status).toBe(201);
    const url = ((await inv.json()) as { url: string }).url,
      secret = url.split("#token=")[1];
    expect(
      (
        await request("/api/invitations/inspect", {
          method: "POST",
          body: { token: secret },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/invitations/accept", {
          method: "POST",
          body: { token: secret },
          client: stranger,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("/api/invitations/accept", {
          method: "POST",
          body: { token: secret },
          client: friend,
        })
      ).status,
    ).toBe(200);
    expect((await request("/api/groups/" + g, { client: friend })).status).toBe(
      200,
    );
    expect(
      (
        await request("/api/groups/" + g + "/members/" + friend.id, {
          method: "DELETE",
          client: owner,
        })
      ).status,
    ).toBe(200);
    expect((await request("/api/groups/" + g, { client: friend })).status).toBe(
      404,
    );
  });
  it("keeps drafts private and submitted copies stable across later saves", async () => {
    const a = (await login("writer@example.test")).client;
    const g = await newGroup(a, "Writing group");
    const created = await request("/api/groups/" + g + "/issues", {
      method: "POST",
      client: a,
      body: { title: "Our first issue", deliveryAt: Date.now() + 3600000 },
    });
    expect(created.status).toBe(201);
    const iid = ((await created.json()) as { id: string }).id;
    const path = "/api/groups/" + g + "/issues/" + iid;
    const issue = (await (await request(path, { client: a })).json()) as {
      questions: { id: string }[];
    };
    const q = issue.questions[0].id;
    const update = {
      answers: { [q]: "The first saved answer" },
      photos: [],
      shoutout: "",
      good: "",
    };
    const saved = await request(path + "/contribution", {
      method: "PUT",
      client: a,
      body: { revision: 0, update },
    });
    expect(saved.status).toBe(200);
    let revision = ((await saved.json()) as { revision: number }).revision;
    const sub = await request(path + "/submit", {
      method: "POST",
      client: a,
      body: { revision },
    });
    expect(sub.status).toBe(200);
    revision = ((await sub.json()) as { revision: number }).revision;
    const second = await request(path + "/contribution", {
      method: "PUT",
      client: a,
      body: {
        revision,
        update: { ...update, answers: { [q]: "A later private draft" } },
      },
    });
    expect(second.status).toBe(200);
    const result = (await (await request(path, { client: a })).json()) as {
      contribution: {
        draft: { answers: Record<string, string> };
        submitted: { answers: Record<string, string> };
      };
    };
    expect(result.contribution.draft.answers[q]).toBe("A later private draft");
    expect(result.contribution.submitted.answers[q]).toBe(
      "The first saved answer",
    );
    expect(
      (
        await request(path + "/contribution", {
          method: "PUT",
          client: a,
          body: { revision, update },
        })
      ).status,
    ).toBe(409);
    await db
      .prepare("UPDATE issues SET deadline=? WHERE id=?")
      .bind(Date.now() - 1, iid)
      .run();
    expect(
      (
        await request(path + "/contribution", {
          method: "PUT",
          client: a,
          body: { revision: revision + 1, update },
        })
      ).status,
    ).toBe(409);
  });
  it("publishes the submitted snapshot once and creates one delivery record per recipient", async () => {
    const issue = await db
      .prepare("SELECT id,group_id FROM issues WHERE title='Our first issue'")
      .first<{ id: string; group_id: string }>();
    await Promise.all([
      request("/api/dev/tick", { method: "POST" }),
      request("/api/dev/tick", { method: "POST" }),
    ]);
    const p = await db
      .prepare("SELECT content_json FROM publications WHERE issue_id=?")
      .bind(issue!.id)
      .first<{ content_json: string }>();
    expect(p).toBeTruthy();
    const content = JSON.parse(p!.content_json) as Publication;
    expect(Object.values(content.contributors[0].update.answers)).toContain(
      "The first saved answer",
    );
    expect(Object.values(content.contributors[0].update.answers)).not.toContain(
      "A later private draft",
    );
    expect(
      (await db
        .prepare(
          "SELECT COUNT(*) AS n FROM email_outbox WHERE issue_id=? AND kind='publication'",
        )
        .bind(issue!.id)
        .first<{ n: number }>())!.n,
    ).toBe(1);
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM publications WHERE issue_id=?")
        .bind(issue!.id)
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });
  it("does not retry an unknown email outcome automatically", async () => {
    await request("/api/dev/tick", { method: "POST" });
    const u = await db
      .prepare("SELECT id FROM users WHERE email='writer@example.test'")
      .first<{ id: string }>();
    const i = await db
      .prepare("SELECT id,group_id FROM issues WHERE title='Our first issue'")
      .first<{ id: string; group_id: string }>();
    const stamp = Date.now(),
      oid = webcrypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO email_outbox(id,logical_key,group_id,issue_id,user_id,recipient,kind,next_attempt,created_at,updated_at) VALUES(?,?,?,?,?,?,'publication',?,?,?)",
      )
      .bind(
        oid,
        "uncertain-test",
        i!.group_id,
        i!.id,
        u!.id,
        "writer@example.test",
        stamp,
        stamp,
        stamp,
      )
      .run();
    let sends = 0;
    const env = {
      DB: db,
      ENVIRONMENT: "test",
      EMAIL_MODE: "live",
      OPERATOR_EMAIL: "host@example.test",
      APP_ORIGIN: origin,
      OUTBOX_KEY: "test",
      EMAIL_FROM: "hello@example.test",
      EMAIL: {
        send: async () => {
          sends++;
          throw new Error("Network outcome unknown");
        },
      },
    } as Env;
    await processOutbox(env, 1);
    await processOutbox(env, 1);
    expect(sends).toBe(1);
    expect(
      (await db
        .prepare("SELECT state FROM email_outbox WHERE id=?")
        .bind(oid)
        .first<{ state: string }>())!.state,
    ).toBe("uncertain");
  });
});
