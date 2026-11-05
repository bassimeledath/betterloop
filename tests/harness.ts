import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Env } from "../server/types";
export type TestClient = {
  cookie: string;
  csrf: string;
  id: string;
  email: string;
};
export async function harness({
  emailApi,
  origin = "http://localhost",
}: {
  emailApi?: (request: Request) => Promise<Response>;
  origin?: string;
} = {}) {
  await mkdir("work", { recursive: true });
  const scriptPath = "work/test-" + randomUUID() + ".mjs";
  await build({
    entryPoints: ["server/index.ts"],
    outfile: scriptPath,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const bindings = {
    ENVIRONMENT: "test",
    EMAIL_MODE: "capture",
    OPERATOR_EMAIL: "host@example.test",
    APP_ORIGIN: origin,
    OUTBOX_KEY: "test-encryption",
    ...(emailApi
      ? {
          CF_ACCOUNT_ID: "00000000000000000000000000000000",
          CF_EMAIL_TOKEN: "test-email-enrollment",
        }
      : {}),
  };
  const mf = new Miniflare({
    modules: true,
    scriptPath,
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
    r2Buckets: ["PHOTOS", "BACKUPS"],
    bindings,
    ...(emailApi ? { serviceBindings: { EMAIL_ROUTING_API: emailApi } } : {}),
  });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database,
    bucket = (await mf.getR2Bucket("PHOTOS")) as unknown as R2Bucket,
    backups = (await mf.getR2Bucket("BACKUPS")) as unknown as R2Bucket,
    env = {
      ...bindings,
      DB: db,
      PHOTOS: bucket,
      BACKUPS: backups,
      ...(emailApi
        ? { EMAIL_ROUTING_API: (await mf.getBindings()).EMAIL_ROUTING_API }
        : {}),
    } as Env;
  for (const f of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    for (const statement of (await readFile("migrations/" + f, "utf8"))
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  const request = async (
    path: string,
    {
      method = "GET",
      body,
      client,
      headers = {},
      raw,
    }: {
      method?: string;
      body?: unknown;
      client?: TestClient;
      headers?: Record<string, string>;
      raw?: Uint8Array;
    } = {},
  ) => {
    const h: Record<string, string> = {
      Origin: bindings.APP_ORIGIN,
      ...headers,
    };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (client) {
      h.Cookie = client.cookie;
      h["X-CSRF-Token"] = client.csrf;
    }
    return mf.dispatchFetch(bindings.APP_ORIGIN + path, {
      method,
      headers: h,
      body: raw
        ? Buffer.from(raw)
        : body === undefined
          ? undefined
          : JSON.stringify(body),
    });
  };
  const login = async (
    email: string,
    operator = false,
  ): Promise<TestClient> => {
    await db
      .prepare(
        "INSERT OR IGNORE INTO users(id,email,name,operator,group_allowance,created_at) VALUES(?,?,?,?,5,?)",
      )
      .bind(randomUUID(), email, email.split("@")[0], +operator, Date.now())
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO email_destinations(email,verified,checked_at) VALUES(?,1,?)",
      )
      .bind(email, Date.now())
      .run();
    const req = await request("/api/auth/request", {
      method: "POST",
      body: { email },
      headers: { "CF-Connecting-IP": email },
    });
    if (req.status !== 200) throw new Error(await req.text());
    await request("/api/dev/tick", { method: "POST" });
    const mail = await db
      .prepare(
        "SELECT text FROM captured_emails WHERE recipient=? AND subject='Your sign-in link for Betterloop' ORDER BY created_at DESC LIMIT 1",
      )
      .bind(email)
      .first<{ text: string }>();
    const token = mail!.text.match(/#token=([a-f0-9]{64})/)![1],
      response = await request("/api/auth/consume", {
        method: "POST",
        body: { token },
        headers: { "CF-Connecting-IP": email },
      });
    if (response.status !== 200) throw new Error(await response.text());
    const { csrf } = (await response.json()) as { csrf: string },
      u = await db
        .prepare("SELECT id FROM users WHERE email=?")
        .bind(email)
        .first<{ id: string }>();
    return {
      id: u!.id,
      email,
      csrf,
      cookie: response.headers.get("Set-Cookie")!.split(";")[0],
    };
  };
  const group = async (client: TestClient) => {
    const r = await request("/api/groups", {
      method: "POST",
      client,
      body: {
        name: "Test circle",
        description: "Private updates",
        timezone: "America/Los_Angeles",
        cadence: "monthly",
        recurrence: { day: 3, hour: 17, minute: 0, weekday: 7 },
      },
    });
    if (r.status !== 201) throw new Error(await r.text());
    return ((await r.json()) as { id: string }).id;
  };
  const invite = async (owner: TestClient, friend: TestClient, gid: string) => {
    const r = await request("/api/groups/" + gid + "/invitations", {
      method: "POST",
      client: owner,
      body: { email: friend.email },
    });
    const { url } = (await r.json()) as { url: string };
    const token = url.split("#token=")[1];
    const accepted = await request("/api/invitations/accept", {
      method: "POST",
      body: { token },
      client: friend,
    });
    if (accepted.status !== 200) throw new Error(await accepted.text());
    return token;
  };
  const issue = async (client: TestClient, gid: string) => {
    const r = await request("/api/groups/" + gid + "/issues", {
      method: "POST",
      client,
      body: { title: "The first letter", deliveryAt: Date.now() + 3600000 },
    });
    if (r.status !== 201) throw new Error(await r.text());
    const { id } = (await r.json()) as { id: string };
    const detail = (await (
      await request("/api/groups/" + gid + "/issues/" + id, { client })
    ).json()) as { questions: { id: string }[] };
    return { id, qid: detail.questions[0].id };
  };
  return {
    mf,
    db,
    bucket,
    backups,
    env,
    request,
    login,
    group,
    invite,
    issue,
    close: () => mf.dispose(),
  };
}
