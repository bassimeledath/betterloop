import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { App } from "./types";
import {
  id,
  now,
  token,
  hash,
  encrypt,
  normalizeEmail,
  fail,
  rate,
  audit,
} from "./security";
import { invalidateExports } from "./privacy";
export const account = new Hono<App>();
account.get("/transfers", async (c) => {
  const transfers = (
    await c.env.DB.prepare(
      "SELECT t.id,t.group_id,g.name,t.expires_at FROM transfers t JOIN groups g ON g.id=t.group_id WHERE t.to_user=? AND t.accepted_at IS NULL AND t.expires_at>? AND g.deleted_at IS NULL AND g.owner_id=t.from_user",
    )
      .bind(c.get("session").user.id, now())
      .all()
  ).results;
  return c.json({ transfers });
});
account.get("/sessions", async (c) => {
  const s = c.get("session");
  const sessions = (
    await c.env.DB.prepare(
      "SELECT token_hash,created_at,expires_at FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC",
    )
      .bind(s.user.id, now())
      .all<{ token_hash: string; created_at: number; expires_at: number }>()
  ).results;
  return c.json({
    sessions: sessions.map((x) => ({
      id: x.token_hash,
      createdAt: x.created_at,
      expiresAt: x.expires_at,
      current: x.token_hash === s.tokenHash,
    })),
  });
});
account.delete("/sessions/:id", async (c) => {
  await c.env.DB.prepare(
    "DELETE FROM sessions WHERE token_hash=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("session").user.id)
    .run();
  return c.json({ ok: true });
});
account.delete("/sessions", async (c) => {
  const s = c.get("session");
  await c.env.DB.prepare(
    "DELETE FROM sessions WHERE user_id=? AND token_hash!=?",
  )
    .bind(s.user.id, s.tokenHash)
    .run();
  return c.json({ ok: true });
});
account.post("/email", async (c) => {
  const b = z.object({ email: z.email().max(254) }).parse(await c.req.json()),
    email = normalizeEmail(b.email),
    s = c.get("session"),
    stamp = now();
  await rate(c.env, "email-change:" + s.user.id, 3, 3600000);
  if (email === s.user.email) fail(400, "This is already your account email.");
  if (
    await c.env.DB.prepare("SELECT id FROM users WHERE email=?")
      .bind(email)
      .first()
  )
    fail(409, "That address cannot be used for this account.");
  const eligible = await c.env.DB.prepare(
    "SELECT verified,suppressed FROM email_destinations WHERE email=?",
  )
    .bind(email)
    .first<{ verified: number; suppressed: number }>();
  if (!eligible?.verified || eligible.suppressed) {
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO email_destinations(email,verified,checked_at) VALUES(?,0,?)",
    )
      .bind(email, stamp)
      .run();
    return c.json({
      pendingVerification: true,
      message:
        "Your host needs to confirm this address as a Cloudflare destination. Your current address remains active. Once verified, request the change again.",
    });
  }
  const secret = token(),
    digest = await hash(secret),
    expires = stamp + 15 * 60000,
    payload = await encrypt(c.env, {
      url:
        (c.env.APP_ORIGIN || new URL(c.req.url).origin) +
        "/email/confirm#token=" +
        secret,
    });
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE email_changes SET used_at=? WHERE user_id=? AND used_at IS NULL",
    ).bind(stamp, s.user.id),
    c.env.DB.prepare(
      "UPDATE email_outbox SET state='skipped',payload=NULL,error_code='superseded',updated_at=? WHERE user_id=? AND kind='email_change' AND state='queued'",
    ).bind(stamp, s.user.id),
    c.env.DB.prepare(
      "INSERT INTO email_changes(token_hash,user_id,new_email,expires_at,created_at) VALUES(?,?,?,?,?)",
    ).bind(digest, s.user.id, email, expires, stamp),
    c.env.DB.prepare(
      "INSERT INTO email_outbox(id,logical_key,user_id,recipient,kind,payload,expires_at,next_attempt,created_at,updated_at) VALUES(?,?,?,?,'email_change',?,?,?,?,?)",
    ).bind(
      id(),
      "email-change:" + digest,
      s.user.id,
      email,
      payload,
      expires,
      stamp,
      stamp,
      stamp,
    ),
  ]);
  return c.json({
    pendingVerification: false,
    message:
      "A confirmation link is on its way to your new address. Your current address remains active until you confirm.",
  });
});
account.post("/email/confirm", async (c) => {
  const b = z
      .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await c.req.json()),
    s = c.get("session"),
    digest = await hash(b.token),
    stamp = now(),
    claim = id();
  const change = await c.env.DB.prepare(
    "SELECT new_email FROM email_changes WHERE token_hash=? AND user_id=? AND used_at IS NULL AND expires_at>?",
  )
    .bind(digest, s.user.id, stamp)
    .first<{ new_email: string }>();
  if (!change)
    fail(
      400,
      "This email-change link has expired, was used, or belongs to another account.",
    );
  const eligible = await c.env.DB.prepare(
    "SELECT verified,suppressed FROM email_destinations WHERE email=?",
  )
    .bind(change.new_email)
    .first<{ verified: number; suppressed: number }>();
  if (!eligible?.verified || eligible.suppressed)
    fail(409, "The new address is not currently eligible for email.");
  const rs = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE email_changes SET used_at=?,claim_key=? WHERE token_hash=? AND user_id=? AND used_at IS NULL AND expires_at>? RETURNING new_email",
    ).bind(stamp, claim, digest, s.user.id, stamp),
    c.env.DB.prepare(
      "UPDATE users SET email=? WHERE id=? AND EXISTS(SELECT 1 FROM email_changes WHERE token_hash=? AND claim_key=?)",
    ).bind(change.new_email, s.user.id, digest, claim),
    c.env.DB.prepare(
      "DELETE FROM sessions WHERE user_id=? AND token_hash!=? AND EXISTS(SELECT 1 FROM email_changes WHERE token_hash=? AND claim_key=?)",
    ).bind(s.user.id, s.tokenHash, digest, claim),
    c.env.DB.prepare(
      "UPDATE login_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM email_changes WHERE token_hash=? AND claim_key=?)",
    ).bind(stamp, s.user.id, digest, claim),
    c.env.DB.prepare(
      "UPDATE email_outbox SET recipient=? WHERE user_id=? AND state='queued' AND kind IN ('opening','reminder','publication','question_reminder') AND EXISTS(SELECT 1 FROM email_changes WHERE token_hash=? AND claim_key=?)",
    ).bind(change.new_email, s.user.id, digest, claim),
  ]);
  if (!rs[0].results.length) fail(400, "This link was already used.");
  await audit(c.env, s.user.id, null, "account.email_changed");
  return c.json({ ok: true });
});
account.delete("/", async (c) => {
  const b = z
      .object({ email: z.email(), removePublished: z.boolean() })
      .parse(await c.req.json()),
    s = c.get("session"),
    stamp = now();
  if (normalizeEmail(b.email) !== s.user.email)
    fail(400, "Type your current email address to confirm.");
  if (
    await c.env.DB.prepare(
      "SELECT id FROM groups WHERE owner_id=? AND deleted_at IS NULL",
    )
      .bind(s.user.id)
      .first()
  )
    fail(
      409,
      "Transfer ownership or delete the groups you own before deleting your account.",
    );
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET deleted_at=?,remove_content=?,name=?,email=?,operator=0,group_allowance=0 WHERE id=? AND deleted_at IS NULL",
    ).bind(
      stamp,
      +b.removePublished,
      "Former member",
      "deleted-" + s.user.id + "@deleted.invalid",
      s.user.id,
    ),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(s.user.id),
    c.env.DB.prepare("DELETE FROM login_tokens WHERE user_id=?").bind(
      s.user.id,
    ),
    c.env.DB.prepare("DELETE FROM email_changes WHERE user_id=?").bind(
      s.user.id,
    ),
    c.env.DB.prepare("DELETE FROM join_signups WHERE email=?").bind(
      s.user.email,
    ),
    c.env.DB.prepare("UPDATE memberships SET active=0 WHERE user_id=?").bind(
      s.user.id,
    ),
    c.env.DB.prepare("DELETE FROM contributions WHERE user_id=?").bind(
      s.user.id,
    ),
    c.env.DB.prepare(
      "UPDATE questions SET author_id=NULL WHERE author_id=?",
    ).bind(s.user.id),
    c.env.DB.prepare(
      "UPDATE email_outbox SET state=CASE WHEN state IN ('queued','sending') THEN 'skipped' ELSE state END,payload=NULL,recipient='deleted@deleted.invalid',updated_at=? WHERE user_id=?",
    ).bind(stamp, s.user.id),
    c.env.DB.prepare("DELETE FROM captured_emails WHERE recipient=?").bind(
      s.user.email,
    ),
    c.env.DB.prepare(
      "UPDATE invitations SET revoked_at=?,email=? WHERE email=?",
    ).bind(stamp, "deleted-" + s.user.id + "@deleted.invalid", s.user.email),
    c.env.DB.prepare("DELETE FROM email_destinations WHERE email=?").bind(
      s.user.email,
    ),
    c.env.DB.prepare(
      "INSERT INTO deletion_records(id,user_id,scope,created_at) VALUES(?,?,?,?)",
    ).bind(
      id(),
      s.user.id,
      b.removePublished ? "user_content" : "user_profile",
      stamp,
    ),
  ]);
  await invalidateExports(c.env, s.user.id, stamp);
  deleteCookie(c, "ll_session", { path: "/" });
  return c.json({
    ok: true,
    message:
      "Account access is revoked. Archive redaction and unreferenced photo cleanup will continue automatically. Previously sent email copies cannot be recalled.",
  });
});
