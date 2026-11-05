import type { Context } from "hono";
import type { App } from "./types";
import { id, now } from "./security";

const identifier = (value: string | undefined) =>
  value &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    ? value
    : null;

export async function recordRequest(c: Context<App>, started: number) {
  if (!c.req.path.startsWith("/api/")) return;
  // Route patterns and fixed metadata only: never URLs, bodies, headers or error messages.
  const details = {
    requestId: c.get("requestId"),
    operation: c.req.method + " " + c.req.routePath,
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
    status: c.res.status,
    error_code: c.res.status >= 400 ? "http_" + c.res.status : null,
  };
  const groupId = identifier(c.req.param("groupId"));
  const issueId = identifier(c.req.param("issueId"));
  console.info(
    JSON.stringify({
      event: "request.completed",
      ...details,
      groupId,
      issueId,
    }),
  );
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.res.status < 400)
    return;
  const actor = c.get("session")?.user.id || null;
  // Rejected anonymous traffic stays in platform logs rather than consuming D1 writes.
  if (!actor && !(c.res.status < 400 && c.req.path.startsWith("/api/auth/")))
    return;
  try {
    await c.env.DB.prepare(
      "INSERT INTO audit_events(id,actor_id,group_id,action,target,created_at,details_json) VALUES(?,?,?,'request.completed',?,?,?)",
    )
      .bind(id(), actor, groupId, issueId, now(), JSON.stringify(details))
      .run();
  } catch {
    // Observability failure must not turn a committed user action into a retry.
    console.warn(
      JSON.stringify({
        event: "request.audit_failed",
        requestId: details.requestId,
        error_code: "audit_unavailable",
      }),
    );
  }
}
