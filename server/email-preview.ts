import { Hono } from "hono";
import type { App, Publication, Update, User } from "./types";
import { member, fail } from "./security";
import { redactPublication } from "./privacy";
import { publicationMail } from "./mail";
import { emailImages } from "./email-images";
export const emailPreview = new Hono<App>();
emailPreview.get(
  "/groups/:groupId/issues/:issueId/email-preview",
  async (c) => {
    const gid = c.req.param("groupId"),
      iid = c.req.param("issueId");
    await member(c, gid);
    const issue = await c.env.DB.prepare(
      "SELECT i.title,g.name,g.cover_id,c.caption AS cover_caption FROM issues i JOIN groups g ON g.id=i.group_id LEFT JOIN group_covers c ON c.id=g.cover_id WHERE i.id=? AND i.group_id=?",
    )
      .bind(iid, gid)
      .first<{
        title: string;
        name: string;
        cover_id: string | null;
        cover_caption: string | null;
      }>();
    if (!issue) fail(404, "Issue not found.");
    const published = await c.env.DB.prepare(
      "SELECT content_json FROM publications WHERE issue_id=? AND group_id=?",
    )
      .bind(iid, gid)
      .first<{ content_json: string }>();
    let p: Publication;
    if (published)
      p = await redactPublication(c.env, JSON.parse(published.content_json));
    else {
      const user = c.get("session").user,
        own = await c.env.DB.prepare(
          "SELECT draft_json FROM contributions WHERE issue_id=? AND user_id=?",
        )
          .bind(iid, user.id)
          .first<{ draft_json: string }>();
      const questions = (
        await c.env.DB.prepare(
          "SELECT id,text,author_name,author_id FROM issue_questions WHERE issue_id=? AND group_id=? ORDER BY position",
        )
          .bind(iid, gid)
          .all<Publication["questions"][number]>()
      ).results;
      p = {
        schemaVersion: 1,
        groupName: issue.name,
        title: issue.title,
        coverId: issue.cover_id,
        coverCaption: issue.cover_caption || "",
        questions,
        contributors: own
          ? [
              {
                id: user.id,
                name: user.name,
                update: JSON.parse(own.draft_json) as Update,
              },
            ]
          : [],
      };
    }
    const images = await emailImages(c.env, gid, p);
    const sources = Object.fromEntries(
      Object.keys(images.sources).map((id) => [
        id,
        id === p.coverId
          ? "/api/groups/" + gid + "/covers/" + id
          : "/api/assets/" + id + "/email",
      ]),
    );
    const mail = publicationMail(
      p,
      (c.env.APP_ORIGIN || new URL(c.req.url).origin) +
        "/groups/" +
        gid +
        "/issues/" +
        iid,
      sources,
    );
    c.header("X-Frame-Options", "SAMEORIGIN");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    );
    const note = published
      ? "Published letter email preview."
      : "Personal draft preview: only your saved draft is shown. Submit it to include your changes. Other members’ answers stay private until publication.";
    return c.html(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Betterloop email preview</title></head><body style="margin:0"><p style="font:14px Arial;padding:16px;background:#e7d9ef;margin:0">' +
        note +
        "<br>Delivered images may be saved or forwarded. Very large letters link to photos that exceed email limits.</p>" +
        mail.html +
        "</body></html>",
    );
  },
);
