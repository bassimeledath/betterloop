import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { harness, type TestClient } from "./harness";
import { processOutbox } from "../server/mail";
import { runSignupStep } from "../server/shared-join";
let h: Awaited<ReturnType<typeof harness>>;
let provider: ReturnType<typeof mockProvider>;
function mockProvider() {
  const addresses = new Map<
      string,
      { id: string; email: string; verified: string | null }
    >(),
    created: string[] = [];
  let unknownCreate = false;
  const fetch = async (request: Request) => {
    expect(request.headers.get("Authorization")).toBe(
      "Bearer test-email-enrollment",
    );
    const path = new URL(request.url).pathname,
      match = path.match(/\/addresses\/([^/]+)$/);
    if (request.method === "GET" && match) {
      const row = [...addresses.values()].find(
        (a) => a.id === decodeURIComponent(match[1]),
      );
      return Response.json(
        { success: !!row, result: row },
        { status: row ? 200 : 404 },
      );
    }
    if (request.method === "GET")
      return Response.json({
        success: true,
        result: [...addresses.values()],
        result_info: { total_pages: 1 },
      });
    const { email } = (await request.json()) as { email: string };
    if (addresses.has(email))
      return Response.json({ success: false }, { status: 409 });
    const row = {
      id: randomUUID().replaceAll("-", ""),
      email,
      verified: null as string | null,
    };
    addresses.set(email, row);
    created.push(email);
    if (unknownCreate) {
      unknownCreate = false;
      throw new Error("Synthetic unknown enrollment outcome");
    }
    return Response.json({ success: true, result: row });
  };
  return {
    fetch,
    addresses,
    created,
    verify(email: string) {
      addresses.get(email)!.verified = new Date().toISOString();
    },
    unknownNextCreate() {
      unknownCreate = true;
    },
  };
}
beforeEach(async () => {
  provider = mockProvider();
  h = await harness({ emailApi: provider.fetch });
}, 30000);
afterEach(async () => {
  await h.close();
});
async function createLink(owner: TestClient, gid: string, rotate = false) {
  const response = await h.request("/api/groups/" + gid + "/join-link", {
    method: "POST",
    client: owner,
    body: { rotate },
  });
  expect(response.status).toBe(200);
  const data = (await response.json()) as { url: string };
  return new URLSearchParams(new URL(data.url).hash.slice(1)).get("token")!;
}
async function register(
  secret: string,
  email: string,
  name = "A friend",
  requestId = randomUUID(),
) {
  const response = await h.request("/api/join/register", {
    method: "POST",
    body: { token: secret, email, name, requestId },
  });
  return {
    response,
    data: (await response.json()) as { ticket: string; stage: string },
  };
}
async function check(ticket: string) {
  await h.db
    .prepare("UPDATE join_signups SET check_after=0 WHERE ticket_hash=?")
    .bind(createHash("sha256").update(ticket).digest("hex"))
    .run();
  return h.request("/api/join/status", { method: "POST", body: { ticket } });
}

async function loginToken(email: string) {
  await processOutbox(h.env, 20);
  const mail = await h.db
    .prepare(
      "SELECT text FROM captured_emails WHERE recipient=? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(email)
    .first<{ text: string }>();
  expect(mail).not.toBeNull();
  return {
    token: mail!.text.match(/#token=([a-f0-9]{64})/)![1],
    text: mail!.text,
  };
}
async function consume(email: string, secret: string) {
  const response = await h.request("/api/auth/consume", {
    method: "POST",
    body: { token: secret },
    headers: { "CF-Connecting-IP": email },
  });
  const data = (await response.json()) as { csrf: string; returnPath: string };
  const user = await h.db
    .prepare("SELECT id FROM users WHERE email=?")
    .bind(email)
    .first<{ id: string }>();
  return {
    response,
    data,
    client: {
      id: user!.id,
      email,
      csrf: data.csrf,
      cookie: response.headers.get("Set-Cookie")?.split(";")[0] || "",
    } as TestClient,
  };
}

it("verifies a new address and automatically joins only after deliberate email confirmation", async () => {
  const owner = await h.login("owner@example.test", true),
    gid = await h.group(owner),
    secret = await createLink(owner, gid),
    email = "new@example.test";
  const preview = await h.request("/api/join/inspect", {
    method: "POST",
    body: { token: secret },
  });
  expect(preview.status).toBe(200);
  expect(await preview.json()).toEqual({
    name: "Test circle",
    description: "Private updates",
    full: false,
  });
  expect((await h.request("/api/groups/" + gid)).status).toBe(401);
  const signup = await register(secret, email, "New friend");
  expect(signup.response.status).toBe(201);
  expect(signup.data.stage).toBe("verification");
  expect(provider.created).toEqual([email]);
  expect(
    await h.db
      .prepare("SELECT id FROM users WHERE email=?")
      .bind(email)
      .first(),
  ).toBeNull();
  expect(
    await h.db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE group_id=?")
      .bind(gid)
      .first(),
  ).toEqual({ n: 1 });
  provider.verify(email);
  expect(
    ((await (await check(signup.data.ticket)).json()) as { stage: string })
      .stage,
  ).toBe("email");
  expect((await h.request("/api/me")).status).toBe(401);
  const mail = await loginToken(email);
  expect(mail.text).toContain("Confirm your email to join Test circle");
  await h.request("/auth/confirm#token=" + mail.token);
  expect(
    await h.db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE group_id=?")
      .bind(gid)
      .first(),
  ).toEqual({ n: 1 });
  const signed = await consume(email, mail.token);
  expect(signed.response.status).toBe(200);
  expect(signed.data.returnPath).toBe("/groups/" + gid);
  expect(
    await h.db
      .prepare("SELECT role FROM memberships WHERE group_id=? AND user_id=?")
      .bind(gid, signed.client.id)
      .first(),
  ).toEqual({ role: "member" });
  expect(
    await h.db
      .prepare("SELECT operator,group_allowance,name FROM users WHERE id=?")
      .bind(signed.client.id)
      .first(),
  ).toEqual({ operator: 0, group_allowance: 0, name: "New friend" });
  expect(
    (await h.request("/api/groups/" + gid, { client: signed.client })).status,
  ).toBe(200);
  expect(
    (
      await h.request("/api/auth/consume", {
        method: "POST",
        body: { token: mail.token },
      })
    ).status,
  ).toBe(400);
});

it("deduplicates signup retries and recovers an unknown provider outcome without another verification email", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    secret = await createLink(owner, gid),
    email = "retry@example.test",
    requestId = randomUUID();
  provider.unknownNextCreate();
  const [a, b] = await Promise.all([
    register(secret, email, "Friend", requestId),
    register(secret, email, "Friend", requestId),
  ]);
  expect([a.response.status, b.response.status].sort()).toEqual([200, 201]);
  expect(a.data.ticket).toBe(b.data.ticket);
  expect(provider.created).toEqual([email]);
  expect(
    (await h.db.prepare("SELECT id FROM join_signups").all()).results,
  ).toHaveLength(1);
  expect(
    ((await (await check(a.data.ticket)).json()) as { stage: string }).stage,
  ).toBe("verification");
  expect(provider.created).toEqual([email]);
  provider.verify(email);
  await check(a.data.ticket);
  const mail = await loginToken(email);
  const signed = await consume(email, mail.token);
  expect(signed.response.status).toBe(200);
});

it("finishes verified signup from the scheduler when the guest has left the page", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    secret = await createLink(owner, gid),
    email = "background@example.test";
  const signup = await register(secret, email);
  expect(signup.data.stage).toBe("verification");
  provider.verify(email);
  await h.db.prepare("UPDATE join_signups SET check_after=0").run();
  const scheduled = await (await h.mf.getWorker()).scheduled();
  await scheduled;
  expect(
    await h.db
      .prepare("SELECT value FROM service_state WHERE key='cron'")
      .first(),
  ).toEqual({ value: "ok" });
  expect(await h.db.prepare("SELECT stage FROM join_signups").first()).toEqual({
    stage: "email",
  });
  const mail = await loginToken(email);
  expect((await consume(email, mail.token)).data.returnPath).toBe(
    "/groups/" + gid,
  );
});

it("keeps a verified destination from impersonating its existing account and preserves its profile and owner role", async () => {
  const owner = await h.login("owner@example.test", true),
    gid = await h.group(owner),
    secret = await createLink(owner, gid);
  const signup = await register(secret, owner.email, "An untrusted new name");
  expect(signup.data.stage).toBe("email");
  expect((await h.request("/api/groups/" + gid)).status).toBe(401);
  const mail = await loginToken(owner.email),
    signed = await consume(owner.email, mail.token);
  expect(signed.response.status).toBe(200);
  expect(
    await h.db
      .prepare("SELECT name,operator FROM users WHERE id=?")
      .bind(owner.id)
      .first(),
  ).toEqual({ name: "owner", operator: 1 });
  expect(
    await h.db
      .prepare("SELECT role FROM memberships WHERE group_id=? AND user_id=?")
      .bind(gid, owner.id)
      .first(),
  ).toEqual({ role: "owner" });
});

it("replaces and closes links immediately, revoking unfinished signup tokens and keeping controls private", async () => {
  const owner = await h.login("owner@example.test"),
    outsider = await h.login("outsider@example.test"),
    gid = await h.group(owner),
    secret = await createLink(owner, gid),
    email = "rotate@example.test";
  expect(
    (await h.request("/api/groups/" + gid + "/join-link", { client: outsider }))
      .status,
  ).toBe(404);
  await register(secret, email);
  provider.verify(email);
  await h.db.prepare("UPDATE join_signups SET check_after=0").run();
  await runSignupStep(h.env);
  const mail = await loginToken(email);
  const replacement = await createLink(owner, gid, true);
  expect(replacement).not.toBe(secret);
  expect(
    (
      await h.request("/api/join/inspect", {
        method: "POST",
        body: { token: secret },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await h.request("/api/auth/consume", {
        method: "POST",
        body: { token: mail.token },
      })
    ).status,
  ).toBe(400);
  expect(
    (await h.db.prepare("SELECT id FROM join_signups").all()).results,
  ).toHaveLength(0);
  expect(
    (
      await h.request("/api/groups/" + gid + "/join-link", {
        method: "DELETE",
        client: owner,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.request("/api/join/inspect", {
        method: "POST",
        body: { token: replacement },
      })
    ).status,
  ).toBe(404);
});

it("enforces twenty members atomically while allowing an existing member to use the same link", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    secret = await createLink(owner, gid),
    stamp = Date.now();
  for (let i = 0; i < 18; i++) {
    await h.db
      .prepare("INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)")
      .bind("member-" + i, "member-" + i + "@example.test", "Member", stamp)
      .run();
    await h.db
      .prepare(
        "INSERT INTO memberships(group_id,user_id,role,joined_at) VALUES(?,?,'member',?)",
      )
      .bind(gid, "member-" + i, stamp)
      .run();
  }
  const emails = ["last-a@example.test", "last-b@example.test"],
    tokens: string[] = [];
  for (const email of emails) {
    const signup = await register(secret, email);
    provider.verify(email);
    await check(signup.data.ticket);
    tokens.push((await loginToken(email)).token);
  }
  const results = await Promise.all(
    emails.map((email, i) => consume(email, tokens[i])),
  );
  expect(results.every((r) => r.response.status === 200)).toBe(true);
  expect(
    results.filter((r) => r.data.returnPath === "/groups/" + gid),
  ).toHaveLength(1);
  expect(
    await h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM memberships WHERE group_id=? AND active=1",
      )
      .bind(gid)
      .first(),
  ).toEqual({ n: 20 });
  expect(
    (
      await h.request("/api/join/accept", {
        method: "POST",
        client: owner,
        body: { token: secret },
      })
    ).status,
  ).toBe(200);
  const loser = results.find((r) => r.data.returnPath !== "/groups/" + gid)!;
  expect(
    (await h.request("/api/groups/" + gid, { client: loser.client })).status,
  ).toBe(404);
});

it("blocks removed members, lets a personal invitation readmit them, and never restores an old admin role", async () => {
  const owner = await h.login("owner@example.test"),
    friend = await h.login("friend@example.test"),
    gid = await h.group(owner),
    secret = await createLink(owner, gid);
  expect(
    (
      await h.request("/api/join/accept", {
        method: "POST",
        client: friend,
        body: { token: secret },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.request("/api/groups/" + gid + "/members/" + friend.id, {
        method: "DELETE",
        client: owner,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.request("/api/join/accept", {
        method: "POST",
        client: friend,
        body: { token: secret },
      })
    ).status,
  ).toBe(409);
  expect((await register(secret, friend.email)).response.status).toBe(403);
  await h.invite(owner, friend, gid);
  await h.request("/api/groups/" + gid + "/members/" + friend.id, {
    method: "PATCH",
    client: owner,
    body: { role: "admin" },
  });
  await h.request("/api/groups/" + gid + "/members/" + friend.id, {
    method: "DELETE",
    client: friend,
  });
  expect(
    (
      await h.request("/api/join/accept", {
        method: "POST",
        client: friend,
        body: { token: secret },
      })
    ).status,
  ).toBe(200);
  expect(
    await h.db
      .prepare(
        "SELECT role,shared_join_blocked FROM memberships WHERE group_id=? AND user_id=?",
      )
      .bind(gid, friend.id)
      .first(),
  ).toEqual({ role: "member", shared_join_blocked: 0 });
});

it("does not autojoin from a signup ticket injected into an ordinary sign-in return path", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    secret = await createLink(owner, gid),
    email = "return-path@example.test";
  const signup = await register(secret, email);
  provider.verify(email);
  await check(signup.data.ticket);
  expect(
    (
      await h.request("/api/auth/request", {
        method: "POST",
        body: {
          email,
          returnPath: "/join#token=" + secret + "&signup=" + signup.data.ticket,
        },
        headers: { "CF-Connecting-IP": email },
      })
    ).status,
  ).toBe(200);
  const mail = await loginToken(email),
    signed = await consume(email, mail.token);
  expect(signed.response.status).toBe(200);
  expect(
    await h.db
      .prepare("SELECT user_id FROM memberships WHERE group_id=? AND user_id=?")
      .bind(gid, signed.client.id)
      .first(),
  ).toBeNull();
  expect(
    (
      await h.request("/api/join/accept", {
        method: "POST",
        client: signed.client,
        body: { token: secret },
      })
    ).status,
  ).toBe(200);
});

it("rejects cross-origin signup, expired tickets and suppressed addresses without granting access", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    secret = await createLink(owner, gid);
  const rejected = await h.request("/api/join/register", {
    method: "POST",
    headers: { Origin: "https://elsewhere.example" },
    body: {
      token: secret,
      email: "foreign@example.test",
      name: "Friend",
      requestId: randomUUID(),
    },
  });
  expect(rejected.status).toBe(403);
  expect(provider.created).toEqual([]);
  const signup = await register(secret, "expired@example.test");
  await h.db.prepare("UPDATE join_signups SET expires_at=0").run();
  expect(
    (
      await h.request("/api/join/status", {
        method: "POST",
        body: { ticket: signup.data.ticket },
      })
    ).status,
  ).toBe(404);
  await h.db
    .prepare(
      "INSERT INTO email_destinations(email,verified,suppressed,checked_at) VALUES('suppressed@example.test',1,1,0)",
    )
    .run();
  const suppressed = await register(secret, "suppressed@example.test");
  expect(suppressed.data.stage).toBe("retry");
  expect(provider.created).toEqual(["expired@example.test"]);
  expect(
    await h.db
      .prepare("SELECT id FROM users WHERE email='suppressed@example.test'")
      .first(),
  ).toBeNull();
  expect(
    await h.db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE group_id=?")
      .bind(gid)
      .first(),
  ).toEqual({ n: 1 });
});

it("removes pending signup identity and invalidates its email token on account deletion", async () => {
  const owner = await h.login("owner@example.test"),
    friend = await h.login("delete@example.test"),
    gid = await h.group(owner),
    secret = await createLink(owner, gid);
  const signup = await register(secret, friend.email);
  const mail = await loginToken(friend.email);
  const removed = await h.request("/api/me", {
    method: "DELETE",
    client: friend,
    body: { email: friend.email, removePublished: true },
  });
  expect(removed.status).toBe(200);
  expect(
    await h.db
      .prepare("SELECT id FROM join_signups WHERE email=?")
      .bind(friend.email)
      .first(),
  ).toBeNull();
  expect(
    (
      await h.request("/api/join/status", {
        method: "POST",
        body: { ticket: signup.data.ticket },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await h.request("/api/auth/consume", {
        method: "POST",
        body: { token: mail.token },
      })
    ).status,
  ).toBe(400);
});
