import type { Env, Publication } from "./types";
import { decrypt, id, now } from "./security";
import { redactPublication } from "./privacy";
type Outbox = {
  id: string;
  group_id: string | null;
  issue_id: string | null;
  user_id: string;
  recipient: string;
  kind: string;
  payload: string | null;
  expires_at: number | null;
  attempts: number;
  lease_token: string | null;
  created_at: number;
  reminder_deadline: number | null;
};
export const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
export function publicationMail(p: Publication, url: string) {
  const photoCount = p.contributors.reduce(
    (n, c) => n + c.update.photos.length,
    0,
  );
  const plain = [
    p.groupName,
    p.title,
    ...p.questions.flatMap((q) => [
      q.author_name + " asked: " + q.text,
      ...p.contributors
        .filter((a) => a.update.answers[q.id])
        .map((a) => a.name + ": " + a.update.answers[q.id].slice(0, 1800)),
    ]),
    "Photo Wall: " +
      photoCount +
      " private " +
      (photoCount === 1 ? "photo" : "photos") +
      " — " +
      url,
    "Shout-outs",
    ...p.contributors
      .filter((a) => a.update.shoutout)
      .map((a) => a.name + ": " + a.update.shoutout.slice(0, 1800)),
    "One Good Thing",
    ...p.contributors
      .filter((a) => a.update.good)
      .map((a) => a.name + ": " + a.update.good.slice(0, 1800)),
    `Read the full private issue and photos: ${url}`,
  ].join("\n\n");
  // This lower bound proves the full HTML cannot fit, without building it first.
  const excerptLength = p.contributors.reduce(
    (n, c) =>
      n +
      c.update.shoutout.slice(0, 1000).length +
      c.update.good.slice(0, 1000).length +
      p.questions.reduce(
        (sum, q) => sum + (c.update.answers[q.id] || "").slice(0, 1200).length,
        0,
      ),
    0,
  );
  if (excerptLength > 80000) return summary();
  // The bounded excerpts include each contributor even when the full issue is long.
  const html =
    '<div style="background:#f2edf6;padding:24px;font-family:Arial,sans-serif;color:#302536"><div style="background:#fffefd;max-width:620px;margin:auto;padding:24px"><h1 style="font-family:Georgia,serif">' +
    escapeHtml(p.groupName) +
    "</h1><p>" +
    escapeHtml(p.title) +
    "</p><hr>" +
    p.questions
      .map(
        (q) =>
          '<section style="background:#f5f1f7;padding:16px;margin:20px 0"><h2 style="font-family:Georgia,serif">' +
          escapeHtml(q.author_name) +
          " asked: " +
          escapeHtml(q.text) +
          "</h2>" +
          p.contributors
            .filter((a) => a.update.answers[q.id])
            .map(
              (a) =>
                '<p style="white-space:pre-line"><strong style="color:#71507e">' +
                escapeHtml(a.name) +
                ":</strong> " +
                escapeHtml(a.update.answers[q.id].slice(0, 1200)) +
                "</p>",
            )
            .join("") +
          "</section>",
      )
      .join("") +
    "<h2>📸 Photo Wall</h2><p>" +
    photoCount +
    " private " +
    (photoCount === 1 ? "photo" : "photos") +
    ' · <a href="' +
    escapeHtml(url) +
    '">View on Betterloop</a></p>' +
    ["shoutout", "good"]
      .map(
        (key, i) =>
          "<h2>" +
          ["📣 Shout-outs", "🌤️ One Good Thing"][i] +
          "</h2>" +
          p.contributors
            .filter((a) => a.update[key as "good" | "shoutout"])
            .map(
              (a) =>
                "<p><strong>" +
                escapeHtml(a.name) +
                ":</strong> " +
                escapeHtml(
                  a.update[key as "good" | "shoutout"].slice(0, 1000),
                ) +
                "</p>",
            )
            .join(""),
      )
      .join("") +
    '<p><a href="' +
    escapeHtml(url) +
    '">Read the complete letter and private photos →</a></p><p><a href="' +
    escapeHtml(url.replace(/\/issues\/[^/]+$/, "/preferences")) +
    '">Manage group emails</a></p></div></div>';
  if (new TextEncoder().encode(html).byteLength > 80000) return summary();
  return { text: plain, html };
  function summary() {
    return {
      text: plain,
      html:
        "<h1>" +
        escapeHtml(p.groupName) +
        "</h1><p>A taste of everyone’s update. Read the complete letter and private photos on Betterloop.</p>" +
        p.contributors
          .map(
            (c) =>
              "<section><h2>" +
              escapeHtml(c.name) +
              "</h2><p>" +
              escapeHtml(
                [
                  ...Object.values(c.update.answers),
                  c.update.shoutout,
                  c.update.good,
                ]
                  .filter(Boolean)
                  .join(" · ")
                  .slice(0, 300),
              ) +
              "</p></section>",
          )
          .join("") +
        "<p>📸 " +
        photoCount +
        ' private photos</p><a href="' +
        escapeHtml(url) +
        '">Read your letter</a><p><a href="' +
        escapeHtml(url.replace(/\/issues\/[^/]+$/, "/preferences")) +
        '">Manage group emails</a></p>',
    };
  }
}
export async function processOutbox(env: Env, limit = 2) {
  const stamp = now();
  const [, queued] = await env.DB.batch<Outbox>([
    env.DB.prepare(
      "UPDATE email_outbox SET state='uncertain',payload=NULL,error_code='lease_expired',updated_at=? WHERE state='sending' AND lease_until<?",
    ).bind(stamp, stamp),
    env.DB.prepare(
      "SELECT * FROM email_outbox WHERE state='queued' AND next_attempt<=? ORDER BY CASE WHEN kind='login' THEN 0 ELSE 1 END,created_at LIMIT ?",
    ).bind(stamp, limit),
  ]);
  const rows = queued.results;
  for (const o of rows) {
    const lease = id();
    const claimed = await env.DB.prepare(
      "UPDATE email_outbox SET state='sending',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='queued' RETURNING id",
    )
      .bind(lease, stamp + 120000, stamp, o.id)
      .first();
    if (!claimed) continue;
    const set = async (
      state: string,
      code: string | null,
      provider: string | null = null,
      retry = false,
    ) =>
      env.DB.prepare(
        "UPDATE email_outbox SET state=?,error_code=?,provider_id=?,payload=CASE WHEN ?=1 THEN payload ELSE NULL END,next_attempt=?,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND state='sending'",
      )
        .bind(
          state,
          code,
          provider,
          +retry,
          now() + Math.min(3600000, 60000 * 2 ** o.attempts),
          now(),
          o.id,
          lease,
        )
        .run();
    if (o.expires_at && o.expires_at <= now()) {
      await set("skipped", "expired");
      continue;
    }
    if (!o.expires_at && o.created_at + 86400000 <= now()) {
      await set("failed", "delivery_window_expired");
      continue;
    }
    const user = await env.DB.prepare(
      "SELECT email,deleted_at FROM users WHERE id=?",
    )
      .bind(o.user_id)
      .first<{ email: string; deleted_at: number | null }>();
    const eligible = await env.DB.prepare(
      "SELECT verified,suppressed FROM email_destinations WHERE email=?",
    )
      .bind(o.recipient)
      .first<{ verified: number; suppressed: number }>();
    if (
      !user ||
      user.deleted_at ||
      !eligible?.verified ||
      eligible.suppressed ||
      (o.kind === "login" && user.email !== o.recipient)
    ) {
      await set("skipped", "ineligible_recipient");
      continue;
    }
    let groupName = "Betterloop";
    let collection: {
      deadline: number;
      timezone: string;
      questions: string[];
    } | null = null;
    if (o.group_id) {
      const m = await env.DB.prepare(
        "SELECT m.*,g.name,g.timezone,g.paused,g.deleted_at FROM memberships m JOIN groups g ON g.id=m.group_id WHERE m.user_id=? AND m.group_id=? AND m.active=1",
      )
        .bind(o.user_id, o.group_id)
        .first<{
          name: string;
          timezone: string;
          paused: number;
          deleted_at: number | null;
          notify_open: number;
          notify_reminder: number;
          notify_issue: number;
        }>();
      const pref =
        o.kind === "opening"
          ? "notify_open"
          : o.kind === "reminder"
            ? "notify_reminder"
            : "notify_issue";
      if (
        !m ||
        m.deleted_at ||
        !m[pref] ||
        (m.paused && ["opening", "reminder"].includes(o.kind))
      ) {
        await set("skipped", "membership_or_preference");
        continue;
      }
      groupName = m.name;
      if (o.issue_id && ["opening", "reminder"].includes(o.kind)) {
        const issue = await env.DB.prepare(
          "SELECT i.id,i.deadline,(SELECT json_group_array(text) FROM (SELECT text FROM issue_questions WHERE issue_id=i.id AND group_id=i.group_id ORDER BY position)) AS questions_json FROM issues i WHERE i.id=? AND i.group_id=? AND i.state='open' AND i.deadline>?",
        )
          .bind(o.issue_id, o.group_id, now())
          .first<{ deadline: number; questions_json: string }>();
        const answered =
          o.kind === "reminder"
            ? await env.DB.prepare(
                "SELECT 1 FROM contributions WHERE issue_id=? AND user_id=? AND submitted_json IS NOT NULL",
              )
                .bind(o.issue_id, o.user_id)
                .first()
            : null;
        if (
          !issue ||
          answered ||
          (o.kind === "reminder" &&
            o.reminder_deadline != null &&
            o.reminder_deadline !== issue.deadline)
        ) {
          await set("skipped", "issue_or_submission_changed");
          continue;
        }
        collection = {
          deadline: issue.deadline,
          timezone: m.timezone,
          questions: JSON.parse(issue.questions_json),
        };
      }
    }
    if (env.EMAIL_MODE === "disabled") {
      await set("failed", "mail_not_configured");
      continue;
    }
    let subject = "",
      html = "",
      text = "";
    const origin = env.APP_ORIGIN || "";
    const url = origin + "/groups/" + o.group_id + "/issues/" + o.issue_id;
    try {
      if (o.kind === "login") {
        const p = await decrypt<{ url: string; joinGroup?: string }>(
          env,
          o.payload!,
        );
        subject = p.joinGroup
          ? "Join " + p.joinGroup.replace(/[\r\n]/g, " ") + " on Betterloop"
          : "Your sign-in link for Betterloop";
        const intro = p.joinGroup
          ? "Confirm your email to join " +
            p.joinGroup +
            ". You will be added automatically and can read the group's past issues."
          : "Sign in to Betterloop.";
        text =
          intro +
          "\n" +
          p.url +
          "\nThis link expires after 15 minutes. Ignore it if you did not request it.";
        html =
          "<h1>A little closer.</h1><p>" +
          escapeHtml(intro) +
          '</p><p><a href="' +
          escapeHtml(p.url) +
          '">' +
          (p.joinGroup ? "Confirm email &amp; join" : "Sign in to Betterloop") +
          "</a></p><p>This link expires after 15 minutes. Ignore it if you did not request it.</p>";
      } else if (o.kind === "email_change") {
        const p = await decrypt<{ url: string }>(env, o.payload!);
        subject = "Confirm your new Betterloop email";
        text =
          "Confirm your new email address: " +
          p.url +
          "\nSign in to your existing account first. This link expires after 15 minutes.";
        html =
          '<h1>A new inbox.</h1><p><a href="' +
          escapeHtml(p.url) +
          '">Confirm your new Betterloop email</a></p><p>Sign in to your existing account first. This link expires after 15 minutes.</p>';
      } else if (o.kind === "publication") {
        const r = await env.DB.prepare(
          "SELECT content_json FROM publications WHERE issue_id=? AND group_id=?",
        )
          .bind(o.issue_id, o.group_id)
          .first<{ content_json: string }>();
        if (!r) {
          await set("skipped", "publication_missing");
          continue;
        }
        const m = publicationMail(
          await redactPublication(env, JSON.parse(r.content_json)),
          url,
        );
        subject = groupName + ": your little letter is here";
        html = m.html;
        text = m.text;
      } else {
        if (!collection) throw new Error("collection_context_missing");
        const deadline = new Intl.DateTimeFormat("en-US", {
          weekday: "short",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone: collection.timezone,
          timeZoneName: "short",
        }).format(collection.deadline);
        const due = deadline + " (" + collection.timezone + ")";
        const preferences = origin + "/groups/" + o.group_id + "/preferences";
        subject =
          groupName +
          (o.kind === "reminder"
            ? ": a little reminder"
            : ": time for a little update");
        text =
          groupName +
          "\nYour group is collecting updates.\nAnswers due " +
          due +
          "\n\nQuestions\n" +
          collection.questions.map((q, n) => n + 1 + ". " + q).join("\n") +
          "\n\nEverything is optional. Add photos, a shout-out, or one good thing too.\n\nWrite your update: " +
          url +
          "\n\nManage group emails: " +
          preferences;
        html =
          "<h1>" +
          escapeHtml(subject) +
          "</h1><p>Your group is collecting updates. Answer as many questions as you like.</p><p><strong>Answers due " +
          escapeHtml(due) +
          "</strong></p><h2>This issue’s questions</h2><ol>" +
          collection.questions
            .map((q) => "<li>" + escapeHtml(q) + "</li>")
            .join("") +
          '</ol><p>Add photos, a shout-out, or one good thing too.</p><a href="' +
          escapeHtml(url) +
          '">Write your update</a><p><a href="' +
          escapeHtml(preferences) +
          '">Manage group emails</a></p>';
      }
    } catch {
      await set("failed", "message_preparation_failed");
      continue;
    }
    try {
      let provider: string;
      if (env.EMAIL_MODE === "capture") {
        if (env.ENVIRONMENT === "production")
          throw Object.assign(new Error("Capture forbidden"), {
            code: "E_CONFIGURATION",
          });
        provider = "capture:" + id();
        await env.DB.prepare(
          "INSERT INTO captured_emails(id,recipient,subject,html,text,created_at) VALUES(?,?,?,?,?,?)",
        )
          .bind(provider, o.recipient, subject, html, text, now())
          .run();
      } else {
        if (!env.EMAIL || !env.EMAIL_FROM)
          throw Object.assign(new Error("Sending unavailable"), {
            code: "E_CONFIGURATION",
          });
        provider = (
          await env.EMAIL.send({
            from: env.EMAIL_FROM,
            to: o.recipient,
            subject,
            html,
            text,
          })
        ).messageId;
      }
      await set("accepted", null, provider);
    } catch (e) {
      const code = (e as { code?: string }).code || "UNKNOWN_SEND_RESULT";
      if (
        [
          "E_RECIPIENT_SUPPRESSED",
          "E_RECIPIENT_NOT_VERIFIED",
          "E_CONFIGURATION",
        ].includes(code)
      )
        await set("failed", code);
      else if (["E_RATE_LIMITED", "E_DAILY_LIMIT_EXCEEDED"].includes(code)) {
        if (o.attempts < 4) await set("queued", code, null, true);
        else await set("failed", code);
      } else await set("uncertain", code);
    }
  }
}
