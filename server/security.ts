import { HTTPException } from "hono/http-exception";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { App, Env, User, Session, Member, Group } from "./types";
export const now = () => Date.now();
export const id = () => crypto.randomUUID();
export const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function fail(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
  message: string,
): never {
  throw new HTTPException(status, { message });
}
export const normalizeEmail = (s: string) => s.trim().toLowerCase();
export function safePath(path: unknown) {
  return typeof path === "string" &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/[\\\r\n]/.test(path) &&
    !path.startsWith("/api/")
    ? path
    : "/";
}
export function local(env: Env) {
  return env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";
}
export function localRequest(c: Context<App>) {
  const h = new URL(c.req.url).hostname;
  return local(c.env) && ["localhost", "127.0.0.1", "[::1]"].includes(h);
}
export async function rate(
  env: Env,
  key: string,
  limit: number,
  windowMs: number,
) {
  const start = Math.floor(now() / windowMs) * windowMs;
  const r = await env.DB.prepare(
    "INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count",
  )
    .bind(key, start)
    .first<{ count: number }>();
  if (!r || r.count > limit)
    fail(429, "Too many attempts. Please try again later.");
}
export async function authenticate(c: Context<App>, next: Next) {
  const secret = getCookie(c, "ll_session");
  if (!secret) fail(401, "Sign in to continue.");
  const tokenHash = await hash(secret);
  const r = await c.env.DB.prepare(
    "SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.deleted_at IS NULL",
  )
    .bind(tokenHash, now())
    .first<User & { csrf: string }>();
  if (!r) fail(401, "Your session has expired. Sign in again.");
  const { csrf, ...user } = r;
  c.set("session", { user, csrf, tokenHash });
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    const expected = c.env.APP_ORIGIN || new URL(c.req.url).origin;
    if (origin !== expected || c.req.header("X-CSRF-Token") !== csrf)
      fail(403, "Refresh this page before trying again.");
  }
  await next();
}
export async function member(
  c: Context<App>,
  groupId: string,
  roles?: Member["role"][],
) {
  const r = await c.env.DB.prepare(
    "SELECT m.* FROM memberships m JOIN groups g ON g.id=m.group_id WHERE m.group_id=? AND m.user_id=? AND m.active=1 AND g.deleted_at IS NULL",
  )
    .bind(groupId, c.get("session").user.id)
    .first<Member>();
  if (!r) fail(404, "This group is not available.");
  if (roles && !roles.includes(r.role))
    fail(403, "Only a group owner or administrator can do that.");
  return r;
}
export async function group(c: Context<App>, groupId: string) {
  await member(c, groupId);
  return (await c.env.DB.prepare(
    "SELECT * FROM groups WHERE id=? AND deleted_at IS NULL",
  )
    .bind(groupId)
    .first<Group>())!;
}
export function operator(c: Context<App>) {
  if (!c.get("session").user.operator) fail(403, "Host access required.");
}
export async function audit(
  env: Env,
  actor: string | null,
  groupId: string | null,
  action: string,
  target: string | null = null,
) {
  await env.DB.prepare(
    "INSERT INTO audit_events(id,actor_id,group_id,action,target,created_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(id(), actor, groupId, action, target, now())
    .run();
}
export async function encrypt(env: Env, value: unknown) {
  if (!env.OUTBOX_KEY)
    fail(503, "The host needs to configure sign-in encryption.");
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(env.OUTBOX_KEY),
    ),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  return btoa(String.fromCharCode(...iv, ...bytes));
}
export async function decrypt<T>(env: Env, value: string): Promise<T> {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(env.OUTBOX_KEY),
    ),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12) },
        key,
        bytes.slice(12),
      ),
    ),
  );
}
