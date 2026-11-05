import type { Env } from "./types";
import { token, hash, now, encrypt, safePath, id, rate } from "./security";
export async function limitLogin(env: Env, email: string, ip: string) {
  await rate(env, "login-ip:" + (await hash(ip)), 20, 3600000);
  await rate(env, "login-email:" + (await hash(email)), 5, 900000);
  await rate(env, "login-global", 100, 3600000);
}
export async function queueLogin(
  env: Env,
  userId: string,
  email: string,
  returnPath: string,
  join?: { signupId: string; groupName: string },
) {
  const secret = token(),
    digest = await hash(secret),
    stamp = now(),
    expires = stamp + 15 * 60000;
  const payload = await encrypt(env, {
    url:
      env.APP_ORIGIN +
      "/auth/confirm#token=" +
      secret +
      (join
        ? "&joining=" +
          encodeURIComponent(join.groupName) +
          "&returnPath=" +
          encodeURIComponent(safePath(returnPath))
        : ""),
    ...(join ? { joinGroup: join.groupName } : {}),
  });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE email_outbox SET state='skipped',payload=NULL,error_code='superseded',updated_at=? WHERE user_id=? AND kind='login' AND state='queued'",
    ).bind(stamp, userId),
    env.DB.prepare(
      "UPDATE login_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL",
    ).bind(stamp, userId),
    env.DB.prepare(
      "INSERT INTO login_tokens(token_hash,user_id,return_path,expires_at,created_at,join_signup_id) VALUES(?,?,?,?,?,?)",
    ).bind(
      digest,
      userId,
      await encrypt(env, { path: safePath(returnPath) }),
      expires,
      stamp,
      join?.signupId || null,
    ),
    env.DB.prepare(
      "INSERT INTO email_outbox(id,logical_key,user_id,recipient,kind,payload,expires_at,next_attempt,created_at,updated_at) VALUES(?,?,?,?,'login',?,?,?,?,?)",
    ).bind(
      id(),
      "login:" + digest,
      userId,
      email,
      payload,
      expires,
      stamp,
      stamp,
      stamp,
    ),
    ...(join
      ? [
          env.DB.prepare(
            "UPDATE join_signups SET login_token_hash=?,login_queued_at=? WHERE id=? AND email=?",
          ).bind(digest, stamp, join.signupId, email),
        ]
      : []),
  ]);
}
