import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { photos } from "./photos";
import { account } from "./account";
import { exportRoutes, runExportStep } from "./exports";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, Env, User } from "./types";
import { auth } from "./auth";
import { groups, invitations } from "./groups";
import { issues } from "./issues";
import {
  authenticate,
  localRequest,
  fail,
  id,
  now,
  operator,
  audit,
  normalizeEmail,
} from "./security";
import { processOutbox } from "./mail";

import { runCleanup } from "./cleanup";
import { recordRequest } from "./telemetry";
import { sharedJoin, runSignupStep } from "./shared-join";
const app = new Hono<App>();
app.use("*", async (c, next) => {
  const started = performance.now();
  c.set("requestId", id());
  await next();
  c.header("X-Request-ID", c.get("requestId"));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  await recordRequest(c, started);
});
app.onError((e, c) => {
  if (e instanceof z.ZodError)
    return c.json(
      {
        error: e.issues.map((i) => i.message).join(" "),
        requestId: c.get("requestId"),
      },
      400,
    );
  if (e instanceof HTTPException)
    return c.json(
      { error: e.message, requestId: c.get("requestId") },
      e.status,
    );
  console.error(
    JSON.stringify({
      event: "request.failed",
      requestId: c.get("requestId"),
      operation: c.req.method + " " + c.req.routePath,
      error: e instanceof Error ? e.name : "Unknown",
    }),
  );
  return c.json(
    {
      error:
        "Something went wrong. Your last saved update is safe. Please retry.",
      requestId: c.get("requestId"),
    },
    500,
  );
});
app.get("/api/health", (c) => c.json({ ok: true, service: "betterloop" }));
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: "This request is too large." }, 413),
  }),
);
app.route("/api/auth", auth);
app.route("/api/invitations", invitations);
app.route("/api/join", sharedJoin);
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/dev/")) {
    if (!localRequest(c)) fail(404, "Not found.");
    await next();
    return;
  }
  await authenticate(c, next);
});
app.route("/api/me", account);
app.route("/api", exportRoutes);
app.get("/api/me", (c) =>
  c.json({ user: c.get("session").user, csrf: c.get("session").csrf }),
);
app.route("/api/groups", groups);
app.route("/api/groups", issues);
app.route("/api", photos);
app.patch("/api/me", async (c) => {
  const b = z
    .object({ name: z.string().trim().min(1).max(80) })
    .parse(await c.req.json());
  await c.env.DB.prepare("UPDATE users SET name=? WHERE id=?")
    .bind(b.name, c.get("session").user.id)
    .run();
  return c.json({ ok: true });
});
app.get("/api/operator", async (c) => {
  operator(c);
  const destinations = (
    await c.env.DB.prepare(
      "SELECT * FROM email_destinations ORDER BY verified,checked_at DESC LIMIT 200",
    ).all()
  ).results;
  const messages = (
    await c.env.DB.prepare(
      "SELECT id,recipient,kind,state,error_code,provider_id,updated_at FROM email_outbox WHERE state IN ('failed','uncertain','queued') ORDER BY updated_at DESC LIMIT 100",
    ).all()
  ).results;
  const users = (
    await c.env.DB.prepare(
      "SELECT id,email,name,group_allowance FROM users WHERE deleted_at IS NULL ORDER BY created_at",
    ).all()
  ).results;
  const heartbeat = await c.env.DB.prepare(
    "SELECT value,updated_at FROM service_state WHERE key='cron'",
  ).first();
  const storage = await c.env.DB.prepare(
    "SELECT (SELECT COALESCE(SUM(bytes),0) FROM assets) AS photos,(SELECT COALESCE(SUM(bytes+12582912),0) FROM exports WHERE state IN ('building','ready') AND expires_at>?) AS exports",
  )
    .bind(now())
    .first();
  const work = (
    await c.env.DB.prepare(
      "SELECT state,COUNT(*) count FROM email_outbox GROUP BY state",
    ).all()
  ).results;
  const stamp = now();
  const due = await c.env.DB.batch<{ count: number; oldest_at: number | null }>(
    [
      c.env.DB.prepare(
        `SELECT COUNT(*) AS count,MIN(CASE WHEN i.state='closing' OR i.deadline<=? THEN i.deadline WHEN i.state='scheduled' OR NOT EXISTS(SELECT 1 FROM service_state WHERE key='opened:'||i.id) THEN i.opens_at ELSE i.reminder_at END) AS oldest_at
      FROM issues i JOIN groups g ON g.id=i.group_id WHERE g.deleted_at IS NULL AND (
        i.state='closing' OR (i.state IN ('scheduled','open') AND i.deadline<=?) OR
        (g.paused=0 AND i.deadline>? AND ((i.state='scheduled' AND i.opens_at<=?) OR
          (i.state='open' AND (NOT EXISTS(SELECT 1 FROM service_state WHERE key='opened:'||i.id) OR (i.reminded_at IS NULL AND i.reminder_at<=?)))))
      )`,
      ).bind(stamp, stamp, stamp, stamp, stamp),
      c.env.DB.prepare(
        "SELECT COUNT(*) AS count,MIN(next_attempt) AS oldest_at FROM email_outbox WHERE state='queued' AND next_attempt<=?",
      ).bind(stamp),
      c.env.DB.prepare(
        "SELECT COUNT(*) AS count,MIN(created_at) AS oldest_at FROM exports WHERE state IN ('planning','building') AND expires_at>? AND (lease_until IS NULL OR lease_until<=?)",
      ).bind(stamp, stamp),
    ],
  );
  const dueWork = {
    issues: due[0].results[0],
    emails: due[1].results[0],
    exports: due[2].results[0],
  };
  let backups: {
    status: string;
    lastReadyAt: number | null;
    bytes: number;
    readyCount: number;
    pendingCount: number;
  } | null = null;
  if (c.env.BACKUPS) {
    try {
      const object = await c.env.BACKUPS.get("index.json");
      const content = object
        ? await object.json<{
            format: string;
            snapshots: { state: string; createdAt: number; bytes: number }[];
          }>()
        : null;
      if (content && content.format !== "betterloop-backup-index-v1")
        throw new Error("Unknown index");
      const snapshots = content?.snapshots || [];
      const ready = snapshots.filter((s) => s.state === "ready");
      backups = {
        status: ready.length ? "ready" : "waiting",
        lastReadyAt: ready.length
          ? Math.max(...ready.map((s) => s.createdAt))
          : null,
        bytes: snapshots.reduce((n, s) => n + s.bytes, 0),
        readyCount: ready.length,
        pendingCount: snapshots.length - ready.length,
      };
    } catch {
      backups = {
        status: "unreadable",
        lastReadyAt: null,
        bytes: 0,
        readyCount: 0,
        pendingCount: 0,
      };
    }
  }
  await audit(c.env, c.get("session").user.id, null, "operator.viewed");
  return c.json({
    destinations,
    messages,
    users,
    mailMode: c.env.EMAIL_MODE,
    heartbeat,
    storage,
    work,
    backups,
    dueWork,
  });
});
app.patch("/api/operator/destinations", async (c) => {
  operator(c);
  const b = z
    .object({
      email: z.email(),
      verified: z.boolean(),
      suppressed: z.boolean().default(false),
    })
    .parse(await c.req.json());
  await c.env.DB.prepare(
    "INSERT INTO email_destinations(email,verified,suppressed,checked_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET verified=excluded.verified,suppressed=excluded.suppressed,checked_at=excluded.checked_at",
  )
    .bind(normalizeEmail(b.email), +b.verified, +b.suppressed, now())
    .run();
  await audit(c.env, c.get("session").user.id, null, "destination.updated");
  return c.json({ ok: true });
});
app.patch("/api/operator/users/:id", async (c) => {
  operator(c);
  const b = z
    .object({ groupAllowance: z.number().int().min(0).max(5) })
    .parse(await c.req.json());
  await c.env.DB.prepare(
    "UPDATE users SET group_allowance=? WHERE id=? AND deleted_at IS NULL",
  )
    .bind(b.groupAllowance, c.req.param("id"))
    .run();
  return c.json({ ok: true });
});
app.post("/api/operator/outbox/:id/resolve", async (c) => {
  operator(c);
  const b = z
    .object({
      action: z.enum(["accepted", "retry"]),
      confirmedProviderCheck: z.literal(true),
    })
    .parse(await c.req.json());
  const r = await c.env.DB.prepare(
    "UPDATE email_outbox SET state=?,next_attempt=?,error_code=NULL,updated_at=? WHERE id=? AND state IN ('failed','uncertain') AND kind NOT IN ('login','email_change') RETURNING id",
  )
    .bind(
      b.action === "retry" ? "queued" : "accepted",
      now(),
      now(),
      c.req.param("id"),
    )
    .first();
  if (!r)
    fail(
      409,
      "This message cannot be retried. Request a new link for sign-in emails.",
    );
  await audit(
    c.env,
    c.get("session").user.id,
    null,
    "outbox." + b.action,
    c.req.param("id"),
  );
  return c.json({ ok: true });
});
app.post("/api/dev/bootstrap", async (c) => {
  const email = c.env.OPERATOR_EMAIL,
    stamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO users(id,email,name,operator,group_allowance,created_at) VALUES(?,?,?,1,5,?)",
    ).bind(id(), email, "Host", stamp),
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO email_destinations(email,verified,checked_at) VALUES(?,1,?)",
    ).bind(email, stamp),
  ]);
  return c.json({ email });
});
app.post("/api/dev/tick", async (c) => {
  const { runScheduler } = await import("./scheduler");
  await runScheduler(c.env);
  await runExportStep(c.env);
  await runCleanup(c.env);
  await runSignupStep(c.env);
  await processOutbox(c.env, 20);
  return c.json({ ok: true });
});
app.get("/api/dev/inbox", async (c) => {
  const emails = (
    await c.env.DB.prepare(
      "SELECT * FROM captured_emails ORDER BY created_at DESC LIMIT 30",
    ).all()
  ).results;
  return c.json({ emails });
});
app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));
app.all("*", async (c) =>
  c.env.ASSETS
    ? await c.env.ASSETS.fetch(c.req.raw)
    : c.text("Betterloop API. Frontend development runs on port 5173."),
);
export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        const record = async (value: string) =>
          env.DB.prepare(
            "INSERT INTO service_state(key,value,updated_at) VALUES('cron',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
          )
            .bind(value, now())
            .run();
        try {
          const { runScheduler } = await import("./scheduler");
          await runScheduler(env);
          await runExportStep(env);
          await runCleanup(env);
          await runSignupStep(env);
          await processOutbox(env);
          await record("ok");
        } catch (e) {
          await record("failed");
          throw e;
        }
      })(),
    );
  },
};
export { app };
