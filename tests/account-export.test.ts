import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { harness, type TestClient } from "./harness";
import { runExportStep } from "../server/exports";
import { runCleanup } from "../server/cleanup";
import { runScheduler } from "../server/scheduler";
import type { Publication } from "../server/types";
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
}, 30000);
afterEach(async () => {
  await h.close();
});
const update = (
  qid: string,
  text: string,
  photos: { id: string; caption: string }[] = [],
) => ({
  answers: { [qid]: text },
  photos,
  shoutout: "A friend doing something lovely.",
  good: "A quiet walk.",
});
async function save(
  client: TestClient,
  gid: string,
  iid: string,
  qid: string,
  text: string,
  photos: { id: string; caption: string }[] = [],
  submit = false,
) {
  const path = "/api/groups/" + gid + "/issues/" + iid;
  const r = await h.request(path + "/contribution", {
    method: "PUT",
    client,
    body: { revision: 0, update: update(qid, text, photos) },
  });
  expect(r.status).toBe(200);
  const { revision } = (await r.json()) as { revision: number };
  if (submit)
    expect(
      (
        await h.request(path + "/submit", {
          method: "POST",
          client,
          body: { revision },
        })
      ).status,
    ).toBe(200);
}
async function publish(iid: string) {
  await h.db
    .prepare("UPDATE issues SET deadline=? WHERE id=?")
    .bind(Date.now() - 1, iid)
    .run();
  await runScheduler(h.env);
}
async function ready(jid: string) {
  for (let n = 0; n < 25; n++) {
    await runExportStep(h.env);
    const j = await h.db
      .prepare("SELECT state,error_code FROM exports WHERE id=?")
      .bind(jid)
      .first<{ state: string; error_code: string | null }>();
    if (j!.state === "ready") return;
    if (j!.state === "failed") throw new Error(j!.error_code!);
  }
  throw new Error("Export did not finish");
}
function untar(bytes: Uint8Array) {
  const result: Record<string, Uint8Array> = {};
  let at = 0;
  const decode = (a: Uint8Array) => new TextDecoder().decode(a).split("\0")[0];
  while (at + 512 <= bytes.length && bytes[at]) {
    const name = decode(bytes.slice(at, at + 100)),
      size = parseInt(decode(bytes.slice(at + 124, at + 136)), 8);
    result[name] = bytes.slice(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}
const jpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1,
  0, 0, 63, 0, 12, 13, 255, 217,
]);
describe("account ownership and private data", () => {
  it("exports all sixty group photos within the Free invocation query budget and fails if a source disappears", async () => {
    const owner = await h.login("owner@example.test"),
      gid = await h.group(owner),
      issue = await h.issue(owner, gid),
      stamp = Date.now();
    const content: Publication = {
      schemaVersion: 1,
      groupName: "A full circle",
      title: "Twenty friends",
      questions: [{ id: issue.qid, text: "How are you?", author_name: "Host" }],
      contributors: [],
    };
    for (let person = 0; person < 20; person++) {
      const uid = person === 0 ? owner.id : "member-" + person;
      if (person)
        await h.db
          .prepare(
            "INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)",
          )
          .bind(uid, uid + "@example.test", uid, stamp)
          .run();
      const photos = [];
      for (let n = 0; n < 3; n++) {
        const aid = "photo-" + person + "-" + n;
        await h.bucket.put(aid, jpeg);
        await h.db
          .prepare(
            "INSERT INTO assets(id,group_id,issue_id,user_id,object_key,content_type,bytes,width,height,state,created_at) VALUES(?,?,?,?,?,'image/jpeg',?,1,1,'ready',?)",
          )
          .bind(aid, gid, issue.id, uid, aid, jpeg.length, stamp)
          .run();
        photos.push({ id: aid, caption: "Photo " + n });
      }
      content.contributors.push({
        id: uid,
        name: uid,
        update: update(issue.qid, "An update", photos),
      });
    }
    await h.db
      .prepare(
        "INSERT INTO publications(issue_id,group_id,content_json,published_at) VALUES(?,?,?,?)",
      )
      .bind(issue.id, gid, JSON.stringify(content), stamp)
      .run();
    const requestExport = async () => {
      const r = await h.request("/api/groups/" + gid + "/exports", {
        method: "POST",
        client: owner,
      });
      expect(r.status).toBe(201);
      return ((await r.json()) as { id: string }).id;
    };
    let queries = 0;
    const count = () => {
      if (++queries > 50)
        throw new Error("Free D1 invocation query limit exceeded");
    };
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...args: unknown[]) => wrap(target.bind(...args));
          const value = Reflect.get(target, property);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            count();
            return value.apply(target, args);
          };
        },
      });
    const db = new Proxy(h.db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => wrap(target.prepare(sql));
        if (property === "batch")
          return (statements: D1PreparedStatement[]) => {
            count();
            return target.batch(statements);
          };
        return Reflect.get(target, property);
      },
    });
    // D1 counts an entire batch as one query against its invocation limit.
    const env = { ...h.env, DB: db },
      jid = await requestExport();
    for (let n = 0; n < 70; n++) {
      queries = 0;
      await runExportStep(env);
      const job = await h.db
        .prepare("SELECT state,error_code FROM exports WHERE id=?")
        .bind(jid)
        .first<{ state: string; error_code: string }>();
      expect(job!.error_code).toBeNull();
      if (job!.state === "ready") break;
    }
    const download = await h.request("/api/exports/" + jid + "/download", {
      client: owner,
    });
    expect(download.status).toBe(200);
    const files = untar(new Uint8Array(await download.arrayBuffer()));
    expect(
      Object.keys(files).filter((p) => p.startsWith("photos/")),
    ).toHaveLength(60);
    for (const person of content.contributors)
      for (const photo of person.update.photos)
        expect(files["photos/" + photo.id + ".jpg"]).toEqual(jpeg);
    const missing = await requestExport();
    await h.db
      .prepare("UPDATE assets SET state='deleting' WHERE id='photo-19-2'")
      .run();
    queries = 0;
    await runExportStep(env);
    expect(
      await h.db
        .prepare("SELECT state,error_code FROM exports WHERE id=?")
        .bind(missing)
        .first(),
    ).toMatchObject({ state: "failed", error_code: "export_photo_missing" });
  }, 30000);
  it("pins a personal export photo before background planning even after it leaves the live draft", async () => {
    const owner = await h.login("owner@example.test"),
      gid = await h.group(owner),
      issue = await h.issue(owner, gid);
    const uploaded = await h.request(
      "/api/groups/" + gid + "/issues/" + issue.id + "/assets",
      {
        method: "POST",
        client: owner,
        headers: { "Content-Type": "image/jpeg" },
        raw: jpeg,
      },
    );
    const aid = ((await uploaded.json()) as { id: string }).id;
    await save(owner, gid, issue.id, issue.qid, "A snapshot", [
      { id: aid, caption: "" },
    ]);
    await h.db
      .prepare("UPDATE assets SET created_at=? WHERE id=?")
      .bind(Date.now() - 2 * 86400000, aid)
      .run();
    const exp = await h.request("/api/me/exports", {
      method: "POST",
      client: owner,
    });
    const jid = ((await exp.json()) as { id: string }).id;
    await h.db
      .prepare(
        "UPDATE contributions SET draft_json=? WHERE issue_id=? AND user_id=?",
      )
      .bind(
        JSON.stringify(update(issue.qid, "Photo removed after export request")),
        issue.id,
        owner.id,
      )
      .run();
    expect(
      (
        await h.request("/api/assets/" + aid, {
          method: "DELETE",
          client: owner,
        })
      ).status,
    ).toBe(200);
    await runCleanup(h.env);
    expect(
      (await h.request("/api/assets/" + aid, { client: owner })).status,
    ).toBe(200);
    await ready(jid);
    const files = untar(
      new Uint8Array(
        await (
          await h.request("/api/exports/" + jid + "/download", {
            client: owner,
          })
        ).arrayBuffer(),
      ),
    );
    expect(files["photos/" + aid + ".jpg"]).toEqual(jpeg);
  });
  it("confirms a new email in the existing account and revokes other sessions", async () => {
    const first = await h.login("old@example.test"),
      second = await h.login("old@example.test");
    let r = await h.request("/api/me/email", {
      method: "POST",
      client: first,
      body: { email: "new@example.test" },
    });
    expect(r.status).toBe(200);
    expect(
      ((await r.json()) as { pendingVerification: boolean })
        .pendingVerification,
    ).toBe(true);
    await h.db
      .prepare("UPDATE email_destinations SET verified=1 WHERE email=?")
      .bind("new@example.test")
      .run();
    r = await h.request("/api/me/email", {
      method: "POST",
      client: first,
      body: { email: "new@example.test" },
    });
    expect(r.status).toBe(200);
    await h.request("/api/dev/tick", { method: "POST" });
    const mail = await h.db
      .prepare(
        "SELECT text FROM captured_emails WHERE recipient=? ORDER BY created_at DESC LIMIT 1",
      )
      .bind("new@example.test")
      .first<{ text: string }>();
    const token = mail!.text.match(/#token=([a-f0-9]{64})/)![1];
    const stranger = await h.login("stranger@example.test");
    expect(
      (
        await h.request("/api/me/email/confirm", {
          method: "POST",
          client: stranger,
          body: { token },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request("/api/me/email/confirm", {
          method: "POST",
          client: first,
          body: { token },
        })
      ).status,
    ).toBe(200);
    expect((await h.request("/api/me", { client: second })).status).toBe(401);
    const me = (await (
      await h.request("/api/me", { client: first })
    ).json()) as { user: { email: string } };
    expect(me.user.email).toBe("new@example.test");
    expect(
      (
        await h.request("/api/me/email/confirm", {
          method: "POST",
          client: first,
          body: { token },
        })
      ).status,
    ).toBe(400);
  });
  it("exports a real archive with photo bytes and excludes private drafts from the group archive", async () => {
    const owner = await h.login("host@example.test", true),
      friend = await h.login("friend@example.test"),
      gid = await h.group(owner);
    await h.invite(owner, friend, gid);
    const issue = await h.issue(owner, gid);
    const uploaded = await h.request(
      "/api/groups/" + gid + "/issues/" + issue.id + "/assets",
      {
        method: "POST",
        client: owner,
        headers: { "Content-Type": "image/jpeg" },
        raw: jpeg,
      },
    );
    expect(uploaded.status).toBe(201);
    const aid = ((await uploaded.json()) as { id: string }).id;
    expect(
      (await h.request("/api/assets/" + aid, { client: friend })).status,
    ).toBe(404);
    await save(
      owner,
      gid,
      issue.id,
      issue.qid,
      "A published update",
      [{ id: aid, caption: "A tiny test photo" }],
      true,
    );
    await save(
      friend,
      gid,
      issue.id,
      issue.qid,
      "A private draft that must stay private",
    );
    await publish(issue.id);
    expect(
      (await h.request("/api/assets/" + aid, { client: friend })).status,
    ).toBe(200);
    expect(
      (
        await h.request("/api/groups/" + gid + "/exports", {
          method: "POST",
          client: friend,
        })
      ).status,
    ).toBe(403);
    const r = await h.request("/api/groups/" + gid + "/exports", {
      method: "POST",
      client: owner,
    });
    expect(r.status).toBe(201);
    const jid = ((await r.json()) as { id: string }).id;
    await ready(jid);
    expect(
      (await h.request("/api/exports/" + jid + "/download", { client: friend }))
        .status,
    ).toBe(404);
    const download = await h.request("/api/exports/" + jid + "/download", {
      client: owner,
    });
    expect(download.status).toBe(200);
    const files = untar(new Uint8Array(await download.arrayBuffer()));
    expect(files["photos/" + aid + ".jpg"]).toEqual(jpeg);
    const json = new TextDecoder().decode(
      files["issues/" + issue.id + ".json"],
    );
    expect(json).toContain("A published update");
    expect(json).not.toContain("A private draft that must stay private");
    expect(files["manifest.json"]).toBeTruthy();
    const personal = await h.request("/api/me/exports", {
      method: "POST",
      client: friend,
    });
    const personalId = ((await personal.json()) as { id: string }).id;
    // Snapshot personal content at request time, even if the live draft changes during preparation.
    await h.db
      .prepare(
        "UPDATE contributions SET draft_json=? WHERE issue_id=? AND user_id=?",
      )
      .bind(
        JSON.stringify(update(issue.qid, "Changed after export request")),
        issue.id,
        friend.id,
      )
      .run();
    await ready(personalId);
    const pfiles = untar(
      new Uint8Array(
        await (
          await h.request("/api/exports/" + personalId + "/download", {
            client: friend,
          })
        ).arrayBuffer(),
      ),
    );
    expect(
      new TextDecoder().decode(pfiles["my-updates/" + issue.id + ".json"]),
    ).toContain("A private draft that must stay private");
    expect(JSON.stringify(Object.keys(pfiles))).not.toContain("issues/");
  });
  it("blocks owner deletion, transfers ownership, then removes published content and old export access", async () => {
    const owner = await h.login("owner@example.test"),
      friend = await h.login("friend@example.test"),
      gid = await h.group(owner);
    await h.invite(owner, friend, gid);
    const issue = await h.issue(owner, gid);
    await save(
      owner,
      gid,
      issue.id,
      issue.qid,
      "Please remove this later",
      [],
      true,
    );
    await publish(issue.id);
    expect(
      (
        await h.request("/api/me", {
          method: "DELETE",
          client: owner,
          body: { email: owner.email, removePublished: true },
        })
      ).status,
    ).toBe(409);
    const t = await h.request("/api/groups/" + gid + "/transfers", {
      method: "POST",
      client: owner,
      body: { userId: friend.id },
    });
    const tid = ((await t.json()) as { id: string }).id;
    expect(
      (
        await h.request(
          "/api/groups/" + gid + "/transfers/" + tid + "/accept",
          { method: "POST", client: friend },
        )
      ).status,
    ).toBe(200);
    const exp = await h.request("/api/groups/" + gid + "/exports", {
      method: "POST",
      client: friend,
    });
    const jid = ((await exp.json()) as { id: string }).id;
    await ready(jid);
    expect(
      (
        await h.request("/api/me", {
          method: "DELETE",
          client: owner,
          body: { email: owner.email, removePublished: true },
        })
      ).status,
    ).toBe(200);
    expect((await h.request("/api/me", { client: owner })).status).toBe(401);
    expect(
      (await h.request("/api/exports/" + jid + "/download", { client: friend }))
        .status,
    ).toBe(404);
    const data = (await (
      await h.request("/api/groups/" + gid + "/issues/" + issue.id, {
        client: friend,
      })
    ).json()) as { publication: Publication };
    expect(data.publication.contributors).toHaveLength(0);
    await runCleanup(h.env);
    const p = await h.db
      .prepare("SELECT content_json FROM publications WHERE issue_id=?")
      .bind(issue.id)
      .first<{ content_json: string }>();
    expect(p!.content_json).not.toContain("Please remove this later");
  });
  it("keeps referenced photos, removes unreferenced uploads, and expires downloads", async () => {
    const owner = await h.login("owner@example.test"),
      gid = await h.group(owner),
      issue = await h.issue(owner, gid);
    const upload = async () => {
      const r = await h.request(
        "/api/groups/" + gid + "/issues/" + issue.id + "/assets",
        {
          method: "POST",
          client: owner,
          headers: { "Content-Type": "image/jpeg" },
          raw: jpeg,
        },
      );
      return ((await r.json()) as { id: string }).id;
    };
    const retained = await upload(),
      orphan = await upload();
    await save(
      owner,
      gid,
      issue.id,
      issue.qid,
      "An update",
      [{ id: retained, caption: "" }],
      true,
    );
    const stamp = Date.now();
    await h.db
      .prepare("UPDATE assets SET created_at=?")
      .bind(stamp - 2 * 86400000)
      .run();
    await runCleanup(h.env, stamp);
    expect(
      (await h.request("/api/assets/" + retained, { client: owner })).status,
    ).toBe(200);
    expect(
      (await h.request("/api/assets/" + orphan, { client: owner })).status,
    ).toBe(404);
    const exp = await h.request("/api/me/exports", {
      method: "POST",
      client: owner,
    });
    const jid = ((await exp.json()) as { id: string }).id;
    await ready(jid);
    await h.db
      .prepare("UPDATE exports SET expires_at=? WHERE id=?")
      .bind(stamp - 1, jid)
      .run();
    expect(
      (await h.request("/api/exports/" + jid + "/download", { client: owner }))
        .status,
    ).toBe(404);
    await runCleanup(h.env, stamp);
    expect(await h.bucket.head("exports/" + jid + "/archive.tar")).toBeNull();
  });
});
