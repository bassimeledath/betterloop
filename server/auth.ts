import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { App, User } from "./types";
import {
  id,
  token,
  hash,
  now,
  rate,
  normalizeEmail,
  safePath,
  decrypt,
  fail,
  authenticate,
  local,
} from "./security";
import { limitLogin, queueLogin } from "./login";
import { signupSigninStatements } from "./shared-join";
export const auth = new Hono<App>();
auth.post("/request", async (c) => {
  const b = z
    .object({
      email: z.email().max(254),
      returnPath: z.string().max(512).optional(),
    })
    .parse(await c.req.json());
  const email = normalizeEmail(b.email),
    stamp = now();
  await limitLogin(c.env, email, c.req.header("CF-Connecting-IP") || "local");
  if (email === normalizeEmail(c.env.OPERATOR_EMAIL))
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO users(id,email,name,operator,group_allowance,created_at) VALUES(?,?,?,1,5,?)",
    )
      .bind(id(), email, "Host", stamp)
      .run();
  const user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE email=? AND deleted_at IS NULL",
  )
    .bind(email)
    .first<User>();
  const destination = await c.env.DB.prepare(
    "SELECT verified,suppressed FROM email_destinations WHERE email=?",
  )
    .bind(email)
    .first<{ verified: number; suppressed: number }>();
  if (user && destination?.verified && !destination.suppressed) {
    await queueLogin(
      { ...c.env, APP_ORIGIN: c.env.APP_ORIGIN || new URL(c.req.url).origin },
      user.id,
      email,
      safePath(b.returnPath),
    );
  }
  return c.json({
    message:
      "If this address is eligible, a sign-in link will arrive shortly. New members may need the host to confirm email verification.",
  });
});
auth.post("/consume", async (c) => {
  if (
    c.req.header("Origin") !== (c.env.APP_ORIGIN || new URL(c.req.url).origin)
  )
    fail(403, "Open the sign-in link in this app.");
  const b = z
    .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(await c.req.json());
  await rate(
    c.env,
    "consume:" + (await hash(c.req.header("CF-Connecting-IP") || "local")),
    30,
    900000,
  );
  const stamp = now(),
    digest = await hash(b.token);
  const login = await c.env.DB.prepare(
    "SELECT l.user_id,l.return_path,l.join_signup_id FROM login_tokens l JOIN users u ON u.id=l.user_id WHERE l.token_hash=? AND l.used_at IS NULL AND l.expires_at>? AND u.deleted_at IS NULL",
  )
    .bind(digest, stamp)
    .first<{
      user_id: string;
      return_path: string;
      join_signup_id: string | null;
    }>();
  if (!login)
    fail(
      400,
      "This link has expired or has already been used. Request a fresh sign-in link.",
    );
  const secret = token(),
    csrf = token(),
    sessionHash = await hash(secret);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE login_tokens SET used_at=?,claim_key=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING user_id",
    ).bind(stamp, sessionHash, digest, stamp),
    c.env.DB.prepare(
      "INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at) SELECT ?,user_id,?,?,? FROM login_tokens WHERE token_hash=? AND claim_key=?",
    ).bind(
      sessionHash,
      csrf,
      stamp + 30 * 86400000,
      stamp,
      digest,
      sessionHash,
    ),
    ...(login.join_signup_id
      ? signupSigninStatements(
          c.env,
          login.join_signup_id,
          login.user_id,
          sessionHash,
          stamp,
        )
      : []),
  ]);
  if (!results[0].results.length)
    fail(400, "This sign-in link has already been used.");
  setCookie(c, "ll_session", secret, {
    httpOnly: true,
    secure: !local(c.env),
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 86400,
  });
  const target = await decrypt<{ path: string }>(c.env, login.return_path);
  const joined = login.join_signup_id
    ? await c.env.DB.prepare(
        "SELECT s.group_id FROM join_signups s JOIN memberships m ON m.group_id=s.group_id AND m.user_id=? AND m.active=1 WHERE s.id=? AND s.joined_at IS NOT NULL",
      )
        .bind(login.user_id, login.join_signup_id)
        .first<{ group_id: string }>()
    : null;
  return c.json({
    returnPath: joined ? "/groups/" + joined.group_id : safePath(target.path),
    csrf,
  });
});
auth.post("/logout", authenticate, async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
    .bind(c.get("session").tokenHash)
    .run();
  deleteCookie(c, "ll_session", { path: "/" });
  return c.json({ ok: true });
});
