import { it, expect } from "vitest";
import { harness } from "./harness";
import { runScheduler } from "../server/scheduler";
import { processOutbox } from "../server/mail";
import { emailImages } from "../server/email-images";
import type { Publication, Env } from "../server/types";
const jpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 0, 2, 0, 4, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1,
  0, 0, 63, 0, 12, 13, 255, 217,
]);
it("restricts cover editing to hosts, preserves snapshotted covers and delivers inline images with escaped captions", async () => {
  const h = await harness();
  try {
    const owner = await h.login("owner@example.test"),
      friend = await h.login("friend@example.test"),
      stranger = await h.login("stranger@example.test"),
      gid = await h.group(owner);
    await h.invite(owner, friend, gid);
    const upload = () =>
      h.request(`/api/groups/${gid}/cover`, {
        method: "POST",
        client: owner,
        raw: jpeg,
        headers: {
          "Content-Type": "image/jpeg",
          "X-Cover-Caption": encodeURIComponent("Our <friends>"),
        },
      });
    expect(
      (
        await h.request(`/api/groups/${gid}/cover`, {
          method: "POST",
          client: friend,
          raw: jpeg,
          headers: { "Content-Type": "image/jpeg" },
        })
      ).status,
    ).toBe(403);
    const r = await upload();
    expect(r.status).toBe(201);
    const cover = ((await r.json()) as { id: string }).id;
    expect((await h.request(`/api/groups/${gid}/covers/${cover}`)).status).toBe(
      401,
    );
    expect(
      (
        await h.request(`/api/groups/${gid}/covers/${cover}`, {
          client: stranger,
        })
      ).status,
    ).toBe(404);
    expect(
      Buffer.from(
        await (
          await h.request(`/api/groups/${gid}/covers/${cover}`, {
            client: friend,
          })
        ).arrayBuffer(),
      ),
    ).toEqual(Buffer.from(jpeg));
    const issue = await h.issue(owner, gid),
      path = `/api/groups/${gid}/issues/${issue.id}`;
    const asset = (
      (await (
        await h.request(path + "/assets", {
          method: "POST",
          client: owner,
          raw: jpeg,
          headers: { "Content-Type": "image/jpeg" },
        })
      ).json()) as { id: string }
    ).id;
    await h.request(path + "/contribution", {
      method: "PUT",
      client: owner,
      body: {
        revision: 0,
        update: {
          answers: { [issue.qid]: "My saved answer" },
          photos: [{ id: asset, caption: "Picnic <3 & friends" }],
          good: "",
          shoutout: "",
        },
      },
    });
    await h.request(path + "/submit", {
      method: "POST",
      client: owner,
      body: { revision: 1 },
    });
    // Another person's submitted answer must not leak into the host's pre-publication preview.
    await h.request(path + "/contribution", {
      method: "PUT",
      client: friend,
      body: {
        revision: 0,
        update: {
          answers: { [issue.qid]: "SECRET UNTIL PUBLISHED" },
          photos: [],
          good: "",
          shoutout: "",
        },
      },
    });
    await h.request(path + "/submit", {
      method: "POST",
      client: friend,
      body: { revision: 1 },
    });
    const preview = await h.request(path + "/email-preview", { client: owner });
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("My saved answer");
    expect(html).not.toContain("SECRET UNTIL PUBLISHED");
    expect(html).toContain("Our &lt;friends&gt;");
    expect(html).toContain("Picnic &lt;3 &amp; friends");
    expect(preview.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    await h.db
      .prepare("UPDATE issues SET deadline=? WHERE id=?")
      .bind(Date.now() - 1, issue.id)
      .run();
    await runScheduler(h.env);
    await upload(); // Replacement does not rewrite the publication's cover.
    const p = JSON.parse(
      (await h.db
        .prepare("SELECT content_json FROM publications WHERE issue_id=?")
        .bind(issue.id)
        .first<{ content_json: string }>())!.content_json,
    ) as Publication;
    expect(p.coverId).toBe(cover);
    const exportResponse = await h.request("/api/groups/" + gid + "/exports", {
      method: "POST",
      client: owner,
      body: { requestId: crypto.randomUUID() },
    });
    expect(exportResponse.status).toBe(201);
    const job = ((await exportResponse.json()) as { id: string }).id;
    const { runExportStep } = await import("../server/exports");
    await runExportStep(h.env);
    const exported = (
      await h.db
        .prepare(
          "SELECT payload_json FROM export_files WHERE job_id=? AND path LIKE 'covers/%'",
        )
        .bind(job)
        .all<{ payload_json: string }>()
    ).results;
    expect(exported).toHaveLength(2);
    for (const f of exported)
      expect(Buffer.from(JSON.parse(f.payload_json).base64, "base64")).toEqual(
        Buffer.from(jpeg),
      );
    const sent: { html: string; attachments?: any[] }[] = [];
    const env: Env = {
      ...h.env,
      EMAIL_MODE: "live",
      EMAIL_FROM: "sender@example.test",
      EMAIL: {
        send: async (m) => {
          sent.push(m);
          return { messageId: "ok" };
        },
      },
    };
    await processOutbox(env, 20);
    const message = sent.find((m) => m.html.includes("Picnic"));
    expect(message).toBeTruthy();
    expect(message!.attachments).toHaveLength(2);
    expect(message!.html).toContain("cid:" + cover + "@betterloop");
    expect(message!.attachments![0].disposition).toBe("inline");
    expect(Buffer.from(message!.attachments![1].content)).toEqual(
      Buffer.from(jpeg),
    );
    expect(
      (await h.request(path + "/email-preview", { client: owner })).headers.get(
        "X-Frame-Options",
      ),
    ).toBe("SAMEORIGIN");
    await h.request(`/api/groups/${gid}/cover`, {
      method: "DELETE",
      client: owner,
    });
    expect(
      (await h.db
        .prepare("SELECT cover_id FROM groups WHERE id=?")
        .bind(gid)
        .first())!.cover_id,
    ).toBeNull();
    expect(
      (await h.request(`/api/groups/${gid}/covers/${cover}`, { client: owner }))
        .status,
    ).toBe(200);
    await h.request("/api/groups/" + gid, {
      method: "DELETE",
      client: owner,
      body: { name: "Test circle" },
    });
    expect(
      (await h.request(`/api/groups/${gid}/covers/${cover}`, { client: owner }))
        .status,
    ).toBe(404);
    const { runCleanup } = await import("../server/cleanup");
    for (let n = 0; n < 10; n++)
      await runCleanup(h.env, Date.now() + 31 * 86400000);
    expect(
      await h.db
        .prepare("SELECT COUNT(*) AS n FROM group_covers WHERE group_id=?")
        .bind(gid)
        .first(),
    ).toEqual({ n: 0 });
  } finally {
    await h.close();
  }
}, 30000);

it("caps email attachments and bytes and uses compact stored derivatives when available", async () => {
  const h = await harness();
  try {
    const owner = await h.login("owner@example.test"),
      gid = await h.group(owner),
      issue = await h.issue(owner, gid);
    const photos = [];
    for (let i = 0; i < 40; i++) {
      const id = crypto.randomUUID();
      photos.push({ id, caption: "" });
      await h.db
        .prepare(
          "INSERT INTO assets(id,group_id,issue_id,user_id,object_key,content_type,bytes,width,height,state,created_at,email_data) VALUES(?,?,?,?,?,'image/jpeg',1048576,4,2,'ready',?,?)",
        )
        .bind(id, gid, issue.id, owner.id, "fake-" + i, Date.now(), jpeg.buffer)
        .run();
    }
    const p: Publication = {
      schemaVersion: 1,
      groupName: "Circle",
      title: "Letter",
      questions: [],
      contributors: [
        {
          id: owner.id,
          name: "Friend",
          update: { answers: {}, photos, good: "", shoutout: "" },
        },
      ],
    };
    const images = await emailImages(h.env, gid, p);
    expect(images.attachments).toHaveLength(32);
    expect(
      images.attachments.every((a) => a.content.byteLength === jpeg.length),
    ).toBe(true);
    await h.db.prepare("UPDATE assets SET email_data=NULL").run();
    for (let i = 0; i < 40; i++)
      await h.bucket.put("fake-" + i, new Uint8Array(1048576));
    expect((await emailImages(h.env, gid, p)).attachments).toHaveLength(12);
  } finally {
    await h.close();
  }
}, 30000);
