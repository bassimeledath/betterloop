import { covers } from "./covers";
import { emailPreview } from "./email-preview";
import { operatorRoutes } from "./operator";
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
  c.header("X-Frame-Options", c.res.headers.get("X-Frame-Options") || "DENY");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  c.header(
    "Content-Security-Policy",
    c.res.headers.get("Content-Security-Policy") ||
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
app.route("/api", covers);
app.route("/api", emailPreview);
app.patch("/api/me", async (c) => {
  const b = z
    .object({ name: z.string().trim().min(1).max(80) })
    .parse(await c.req.json());
  await c.env.DB.prepare("UPDATE users SET name=? WHERE id=?")
    .bind(b.name, c.get("session").user.id)
    .run();
  return c.json({ ok: true });
});
app.route("/", operatorRoutes);
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
  const { enqueueQuestionReminders } = await import("./question-reminders");
  await enqueueQuestionReminders(c.env);
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
    ctx.waitUntil(import("./cron").then(({ runCron }) => runCron(env)));
  },
};
export { app };
