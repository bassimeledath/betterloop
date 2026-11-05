import { Hono, type Context } from "hono";
import { z } from "zod";
import type { App, Env } from "./types";
import {
  id,
  token,
  hash,
  encrypt,
  decrypt,
  now,
  member,
  authenticate,
  fail,
  audit,
  rate,
  normalizeEmail,
} from "./security";
import { emailDestination, enrollmentReady } from "./email-enrollment";
import { limitLogin, queueLogin } from "./login";
type Link = {
  group_id: string;
  token_hash: string;
  token_ciphertext: string | null;
  name: string;
  description: string;
};
type Signup = {
  id: string;
  group_id: string;
  link_hash: string;
  email: string;
  name: string;
  ticket_ciphertext: string;
  stage: string;
  check_after: number;
  enroll_attempted_at: number | null;
  login_queued_at: number | null;
  login_token_hash: string | null;
  joined_at: number | null;
  expires_at: number;
  group_name: string;
};
const capability = z.string().regex(/^[a-f0-9]{64}$/);
const input = z.object({ token: capability });
const origin = (c: Context<App>) =>
  c.env.APP_ORIGIN || new URL(c.req.url).origin;
function sameOrigin(c: Context<App>) {
  if (c.req.header("Origin") !== origin(c))
    fail(403, "Open this signup link in Betterloop.");
}
async function link(env: Env, secret: string) {
  const row = await env.DB.prepare(
    "SELECT j.*,g.name,g.description FROM group_join_links j JOIN groups g ON g.id=j.group_id WHERE j.token_hash=? AND j.enabled=1 AND g.deleted_at IS NULL",
  )
    .bind(await hash(secret))
    .first<Link>();
  if (!row)
    fail(
      404,
      "This group link is closed or has been replaced. Ask your friend for the latest link.",
    );
  return row!;
}
async function ticket(env: Env, secret: string) {
  const row = await env.DB.prepare(
    "SELECT s.*,g.name AS group_name FROM join_signups s JOIN group_join_links j ON j.group_id=s.group_id AND j.token_hash=s.link_hash JOIN groups g ON g.id=s.group_id WHERE s.ticket_hash=? AND s.expires_at>? AND j.enabled=1 AND g.deleted_at IS NULL",
  )
    .bind(await hash(secret), now())
    .first<Signup>();
  if (!row)
    fail(
      404,
      "This signup has expired or its group link changed. Open the latest group link to start again.",
    );
  return row!;
}
const revoke = (env: Env, gid: string, stamp: number, rotate = true) => [
  env.DB.prepare(
    "UPDATE email_outbox SET state='skipped',payload=NULL,error_code='superseded',updated_at=? WHERE kind='login' AND state='queued' AND logical_key IN (SELECT 'login:'||token_hash FROM login_tokens WHERE join_signup_id IN (SELECT id FROM join_signups WHERE group_id=?)) AND (?=1 OR NOT EXISTS(SELECT 1 FROM group_join_links WHERE group_id=? AND enabled=1))",
  ).bind(stamp, gid, +rotate, gid),
  env.DB.prepare(
    "UPDATE login_tokens SET used_at=? WHERE used_at IS NULL AND join_signup_id IN (SELECT id FROM join_signups WHERE group_id=?) AND (?=1 OR NOT EXISTS(SELECT 1 FROM group_join_links WHERE group_id=? AND enabled=1))",
  ).bind(stamp, gid, +rotate, gid),
  env.DB.prepare(
    "DELETE FROM join_signups WHERE group_id=? AND (?=1 OR NOT EXISTS(SELECT 1 FROM group_join_links WHERE group_id=? AND enabled=1))",
  ).bind(gid, +rotate, gid),
];
async function ownerInfo(c: Context<App>, gid: string) {
  const row = await c.env.DB.prepare(
    "SELECT * FROM group_join_links WHERE group_id=?",
  )
    .bind(gid)
    .first<Link & { enabled: number }>();
  return {
    enabled: !!row?.enabled,
    configured: enrollmentReady(c.env),
    url:
      row?.enabled && row.token_ciphertext
        ? origin(c) +
          "/join#token=" +
          (await decrypt<{ token: string }>(c.env, row.token_ciphertext)).token
        : null,
  };
}
export const sharedLinkControls = new Hono<App>();
sharedLinkControls.get("/", async (c) => {
  const gid = c.req.param("groupId") || "";
  await member(c, gid, ["owner", "admin"]);
  return c.json(await ownerInfo(c, gid));
});
sharedLinkControls.post("/", async (c) => {
  const gid = c.req.param("groupId") || "";
  await member(c, gid, ["owner", "admin"]);
  if (!enrollmentReady(c.env))
    fail(
      503,
      "Automatic email setup needs to be finished before enabling a shared group link.",
    );
  const { rotate } = z
    .object({ rotate: z.boolean().default(false) })
    .parse(await c.req.json());
  const stamp = now(),
    secret = token(),
    digest = await hash(secret),
    cipher = await encrypt(c.env, { token: secret });
  await c.env.DB.batch([
    ...revoke(c.env, gid, stamp, rotate),
    c.env.DB.prepare(
      "INSERT INTO group_join_links(group_id,token_hash,token_ciphertext,enabled,created_by,created_at) VALUES(?,?,?,1,?,?) ON CONFLICT(group_id) DO UPDATE SET token_hash=excluded.token_hash,token_ciphertext=excluded.token_ciphertext,enabled=1,created_by=excluded.created_by,created_at=excluded.created_at WHERE group_join_links.enabled=0 OR ?=1",
    ).bind(gid, digest, cipher, c.get("session").user.id, stamp, +rotate),
  ]);
  await audit(
    c.env,
    c.get("session").user.id,
    gid,
    rotate ? "shared_link.replaced" : "shared_link.enabled",
  );
  return c.json(await ownerInfo(c, gid));
});
sharedLinkControls.delete("/", async (c) => {
  const gid = c.req.param("groupId") || "";
  await member(c, gid, ["owner", "admin"]);
  await c.env.DB.batch([
    ...revoke(c.env, gid, now()),
    c.env.DB.prepare(
      "UPDATE group_join_links SET enabled=0,token_ciphertext=NULL WHERE group_id=?",
    ).bind(gid),
  ]);
  await audit(c.env, c.get("session").user.id, gid, "shared_link.disabled");
  return c.json({ ok: true });
});

async function advance(
  c: { env: Env; ip: string; origin: string },
  signup: Signup,
  sharedSecret: string | undefined,
  allowCreate: boolean,
  resend = false,
) {
  if (signup.joined_at) return { stage: "joined", groupId: signup.group_id };
  const stamp = now();
  if (signup.login_token_hash && !resend)
    return { stage: "email", groupId: signup.group_id };
  if (
    resend &&
    signup.login_queued_at &&
    stamp - signup.login_queued_at < 60000
  )
    fail(429, "Wait a minute before requesting another sign-in email.");
  const claimed = await c.env.DB.prepare(
    "UPDATE join_signups SET check_after=? WHERE id=? AND check_after<=? RETURNING id",
  )
    .bind(stamp + 15000, signup.id, stamp)
    .first();
  if (!claimed) return { stage: signup.stage, groupId: signup.group_id };
  let stage = "verification";
  try {
    await rate(c.env, "enrollment-check-global", 180, 60000);
    const create =
      allowCreate &&
      (!signup.enroll_attempted_at ||
        stamp - signup.enroll_attempted_at >= 60000);
    if (create)
      await c.env.DB.prepare(
        "UPDATE join_signups SET enroll_attempted_at=? WHERE id=?",
      )
        .bind(stamp, signup.id)
        .run();
    const verified = await emailDestination(c.env, signup.email, create);
    if (verified) {
      const uid = id();
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES(?,?,?,?)",
      )
        .bind(uid, signup.email, signup.name, stamp)
        .run();
      const user = await c.env.DB.prepare(
        "SELECT id FROM users WHERE email=? AND deleted_at IS NULL",
      )
        .bind(signup.email)
        .first<{ id: string }>();
      if (!user)
        fail(
          403,
          "This signup cannot continue. Please contact the group host.",
        );
      const lease = await c.env.DB.prepare(
        "UPDATE join_signups SET login_queued_at=? WHERE id=? AND (login_queued_at IS NULL OR login_token_hash IS NOT NULL OR login_queued_at<?) RETURNING id",
      )
        .bind(stamp, signup.id, stamp - 60000)
        .first();
      if (lease) {
        await limitLogin(c.env, signup.email, c.ip);
        const rawLink =
          sharedSecret ||
          (
            await decrypt<{ token: string }>(
              c.env,
              (await c.env.DB.prepare(
                "SELECT token_ciphertext FROM group_join_links WHERE group_id=? AND token_hash=? AND enabled=1",
              )
                .bind(signup.group_id, signup.link_hash)
                .first<{ token_ciphertext: string }>())!.token_ciphertext,
            )
          ).token;
        const rawTicket = (
          await decrypt<{ token: string }>(c.env, signup.ticket_ciphertext)
        ).token;
        await queueLogin(
          { ...c.env, APP_ORIGIN: c.origin },
          user!.id,
          signup.email,
          "/join#token=" + rawLink + "&signup=" + rawTicket,
          { signupId: signup.id, groupName: signup.group_name },
        );
      }
      const sent = await c.env.DB.prepare(
        "SELECT login_token_hash FROM join_signups WHERE id=?",
      )
        .bind(signup.id)
        .first<{ login_token_hash: string | null }>();
      stage = sent?.login_token_hash ? "email" : "starting";
    }
  } catch {
    const queued = await c.env.DB.prepare(
      "SELECT login_token_hash FROM join_signups WHERE id=?",
    )
      .bind(signup.id)
      .first<{ login_token_hash: string | null }>();
    stage = queued?.login_token_hash ? "email" : "retry";
    if (!queued?.login_token_hash)
      await c.env.DB.prepare(
        "UPDATE join_signups SET login_queued_at=NULL WHERE id=? AND login_token_hash IS NULL",
      )
        .bind(signup.id)
        .run();
  }
  await c.env.DB.prepare("UPDATE join_signups SET stage=? WHERE id=?")
    .bind(stage, signup.id)
    .run();
  return { stage, groupId: signup.group_id };
}

export const sharedJoin = new Hono<App>();
sharedJoin.post("/inspect", async (c) => {
  const b = input.parse(await c.req.json()),
    j = await link(c.env, b.token);
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM memberships WHERE group_id=? AND active=1",
  )
    .bind(j.group_id)
    .first<{ n: number }>();
  return c.json({
    name: j.name,
    description: j.description,
    full: count!.n >= 20,
  });
});
sharedJoin.post("/register", async (c) => {
  sameOrigin(c);
  const b = input
    .extend({
      email: z.email().max(90),
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .refine(
          (s) => !/[\u0000-\u001f\u007f]/.test(s),
          "Use a name without control characters.",
        ),
      requestId: z.uuid(),
    })
    .parse(await c.req.json());
  const j = await link(c.env, b.token),
    email = normalizeEmail(b.email),
    stamp = now();
  const prior = await c.env.DB.prepare(
    "SELECT s.*,g.name AS group_name FROM join_signups s JOIN groups g ON g.id=s.group_id WHERE s.group_id=? AND s.request_id=?",
  )
    .bind(j.group_id, b.requestId)
    .first<Signup>();
  if (prior) {
    if (
      prior.email !== email ||
      prior.link_hash !== j.token_hash ||
      prior.expires_at <= stamp
    )
      fail(409, "This signup changed. Reopen the group link to start again.");
    return c.json({
      ticket: (await decrypt<{ token: string }>(c.env, prior.ticket_ciphertext))
        .token,
      ...(await advance(
        {
          env: c.env,
          ip: c.req.header("CF-Connecting-IP") || "local",
          origin: origin(c),
        },
        prior,
        b.token,
        false,
      )),
    });
  }
  await rate(
    c.env,
    "join-ip:" + (await hash(c.req.header("CF-Connecting-IP") || "local")),
    30,
    3600000,
  );
  await rate(c.env, "join-email:" + (await hash(email)), 3, 900000);
  await rate(c.env, "join-global", 100, 3600000);
  const blocked = await c.env.DB.prepare(
    "SELECT u.id FROM users u LEFT JOIN memberships m ON m.user_id=u.id AND m.group_id=? LEFT JOIN email_destinations d ON d.email=u.email WHERE u.email=? AND (u.deleted_at IS NOT NULL OR m.shared_join_blocked=1 OR d.suppressed=1)",
  )
    .bind(j.group_id, email)
    .first();
  if (blocked)
    fail(403, "This signup cannot continue. Please contact the group host.");
  const sid = id(),
    secret = token(),
    cipher = await encrypt(c.env, { token: secret });
  const inserted = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO join_signups(id,group_id,link_hash,email,name,ticket_hash,ticket_ciphertext,request_id,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM group_join_links j JOIN groups g ON g.id=j.group_id WHERE j.group_id=? AND j.token_hash=? AND j.enabled=1 AND g.deleted_at IS NULL) AND ((SELECT COUNT(*) FROM memberships WHERE group_id=? AND active=1)<20 OR EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND u.email=? AND m.active=1)) AND (SELECT COUNT(*) FROM join_signups WHERE group_id=? AND expires_at>? AND joined_at IS NULL)<40 RETURNING id",
  )
    .bind(
      sid,
      j.group_id,
      j.token_hash,
      email,
      b.name,
      await hash(secret),
      cipher,
      b.requestId,
      stamp,
      stamp + 7 * 86400000,
      j.group_id,
      j.token_hash,
      j.group_id,
      j.group_id,
      email,
      j.group_id,
      stamp,
    )
    .first();
  if (!inserted) {
    const replay = await c.env.DB.prepare(
      "SELECT ticket_ciphertext,email,link_hash,expires_at FROM join_signups WHERE group_id=? AND request_id=?",
    )
      .bind(j.group_id, b.requestId)
      .first<{
        ticket_ciphertext: string;
        email: string;
        link_hash: string;
        expires_at: number;
      }>();
    if (
      replay &&
      replay.email === email &&
      replay.link_hash === j.token_hash &&
      replay.expires_at > stamp
    )
      return c.json({
        ticket: (
          await decrypt<{ token: string }>(c.env, replay.ticket_ciphertext)
        ).token,
        stage: "starting",
      });
    fail(409, "This group is full or the link changed. Ask the host for help.");
  }
  const signup = await ticket(c.env, secret);
  return c.json(
    {
      ticket: secret,
      ...(await advance(
        {
          env: c.env,
          ip: c.req.header("CF-Connecting-IP") || "local",
          origin: origin(c),
        },
        signup,
        b.token,
        true,
      )),
    },
    201,
  );
});
sharedJoin.post("/status", async (c) => {
  sameOrigin(c);
  const b = z.object({ ticket: capability }).parse(await c.req.json());
  await rate(c.env, "join-status:" + (await hash(b.ticket)), 12, 60000);
  const s = await ticket(c.env, b.ticket);
  return c.json(
    await advance(
      {
        env: c.env,
        ip: c.req.header("CF-Connecting-IP") || "local",
        origin: origin(c),
      },
      s,
      undefined,
      false,
    ),
  );
});
sharedJoin.post("/resend", async (c) => {
  sameOrigin(c);
  const b = z.object({ ticket: capability }).parse(await c.req.json());
  const s = await ticket(c.env, b.ticket);
  await rate(c.env, "join-resend:" + (await hash(s.email)), 3, 900000);
  return c.json(
    await advance(
      {
        env: c.env,
        ip: c.req.header("CF-Connecting-IP") || "local",
        origin: origin(c),
      },
      s,
      undefined,
      true,
      true,
    ),
  );
});
sharedJoin.post("/accept", authenticate, async (c) => {
  const b = input.parse(await c.req.json()),
    j = await link(c.env, b.token),
    user = c.get("session").user,
    stamp = now();
  const result = await c.env.DB.prepare(
    "INSERT INTO memberships(group_id,user_id,role,joined_at) SELECT ?,?,'member',? WHERE EXISTS(SELECT 1 FROM group_join_links j JOIN groups g ON g.id=j.group_id WHERE j.group_id=? AND j.token_hash=? AND j.enabled=1 AND g.deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM memberships WHERE group_id=? AND user_id=? AND shared_join_blocked=1) AND ((SELECT COUNT(*) FROM memberships WHERE group_id=? AND active=1)<20 OR EXISTS(SELECT 1 FROM memberships WHERE group_id=? AND user_id=? AND active=1)) ON CONFLICT(group_id,user_id) DO UPDATE SET active=1,role=CASE WHEN memberships.active=0 THEN 'member' ELSE memberships.role END,joined_at=CASE WHEN memberships.active=0 THEN excluded.joined_at ELSE memberships.joined_at END RETURNING user_id",
  )
    .bind(
      j.group_id,
      user.id,
      stamp,
      j.group_id,
      j.token_hash,
      j.group_id,
      user.id,
      j.group_id,
      j.group_id,
      user.id,
    )
    .first();
  if (!result)
    fail(
      409,
      "This link is closed, the group is full, or the host needs to invite you personally.",
    );
  await audit(c.env, user.id, j.group_id, "shared_link.joined", user.id);
  return c.json({ groupId: j.group_id });
});

export function signupSigninStatements(
  env: Env,
  signupId: string,
  userId: string,
  sessionHash: string,
  stamp: number,
) {
  const eligible = `SELECT s.group_id FROM join_signups s JOIN group_join_links j ON j.group_id=s.group_id AND j.token_hash=s.link_hash JOIN groups g ON g.id=s.group_id JOIN users u ON u.email=s.email JOIN login_tokens l ON l.join_signup_id=s.id AND l.token_hash=s.login_token_hash WHERE s.id=? AND u.id=? AND l.claim_key=? AND s.expires_at>? AND j.enabled=1 AND g.deleted_at IS NULL AND u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM memberships WHERE group_id=s.group_id AND user_id=u.id AND shared_join_blocked=1) AND ((SELECT COUNT(*) FROM memberships WHERE group_id=s.group_id AND active=1)<20 OR EXISTS(SELECT 1 FROM memberships WHERE group_id=s.group_id AND user_id=u.id AND active=1))`;
  return [
    env.DB.prepare(
      "INSERT INTO memberships(group_id,user_id,role,joined_at) SELECT group_id,?,'member',? FROM (" +
        eligible +
        ") WHERE 1 ON CONFLICT(group_id,user_id) DO UPDATE SET active=1,role=CASE WHEN memberships.active=0 THEN 'member' ELSE memberships.role END,joined_at=CASE WHEN memberships.active=0 THEN excluded.joined_at ELSE memberships.joined_at END",
    ).bind(userId, stamp, signupId, userId, sessionHash, stamp),
    env.DB.prepare(
      "UPDATE join_signups SET joined_at=?,stage='joined' WHERE id=? AND EXISTS(SELECT 1 FROM login_tokens WHERE join_signup_id=join_signups.id AND token_hash=join_signups.login_token_hash AND claim_key=?) AND EXISTS(SELECT 1 FROM memberships WHERE group_id=join_signups.group_id AND user_id=? AND active=1)",
    ).bind(stamp, signupId, sessionHash, userId),
    env.DB.prepare(
      "INSERT INTO audit_events(id,actor_id,group_id,action,target,created_at) SELECT ?,?,group_id,'shared_signup.completed',id,? FROM join_signups WHERE id=? AND joined_at=? AND EXISTS(SELECT 1 FROM login_tokens WHERE join_signup_id=join_signups.id AND claim_key=?)",
    ).bind(id(), userId, stamp, signupId, stamp, sessionHash),
  ];
}

export async function runSignupStep(env: Env) {
  if (!enrollmentReady(env) || !env.APP_ORIGIN) return;
  const signup = await env.DB.prepare(
    "SELECT s.*,g.name AS group_name FROM join_signups s JOIN group_join_links j ON j.group_id=s.group_id AND j.token_hash=s.link_hash JOIN groups g ON g.id=s.group_id WHERE s.expires_at>? AND s.joined_at IS NULL AND s.login_token_hash IS NULL AND s.check_after<=? AND j.enabled=1 AND g.deleted_at IS NULL ORDER BY s.check_after,s.created_at LIMIT 1",
  )
    .bind(now(), now())
    .first<Signup>();
  if (signup)
    await advance(
      { env, ip: "signup:" + signup.id, origin: env.APP_ORIGIN },
      signup,
      undefined,
      !signup.enroll_attempted_at,
    );
}
