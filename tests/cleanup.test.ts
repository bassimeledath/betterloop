import { afterEach, beforeEach, expect, it } from "vitest";
import { harness } from "./harness";
import { runCleanup } from "../server/cleanup";
import { finishPhotoUpload } from "../server/photos";
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
}, 30000);
afterEach(async () => {
  await h.close();
});
const DAY = 86400000;
const jpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1,
  0, 0, 63, 0, 12, 13, 255, 217,
]);

it("does not release a pending upload while deletion can still race its R2 write", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid),
    stamp = Date.now();
  const aid = "pending-photo",
    key = gid + "/" + issue.id + "/pending.jpg";
  await h.db
    .prepare(
      "INSERT INTO assets(id,group_id,issue_id,user_id,object_key,content_type,bytes,width,height,state,created_at) VALUES(?,?,?,?,?,'image/jpeg',?,1,1,'pending',?)",
    )
    .bind(aid, gid, issue.id, owner.id, key, jpeg.length, stamp)
    .run();
  expect(
    (
      await h.request("/api/groups/" + gid, {
        method: "DELETE",
        client: owner,
        body: { name: "Test circle" },
      })
    ).status,
  ).toBe(200);
  await runCleanup(h.env, stamp + 60000);
  expect(
    await h.db.prepare("SELECT state FROM assets WHERE id=?").bind(aid).first(),
  ).toEqual({ state: "pending" });
  // Complete the R2 write after the deletion tick, as an in-flight request could.
  await h.bucket.put(key, jpeg);
  expect(await finishPhotoUpload(h.env, aid, key, stamp + 60000)).toBe(false);
  expect(await h.bucket.head(key)).toBeNull();
  expect(
    await h.db.prepare("SELECT id FROM assets WHERE id=?").bind(aid).first(),
  ).toBeNull();
  // A completion arriving after its stale reservation was reaped is also erased.
  await h.bucket.put(key, jpeg);
  expect(await finishPhotoUpload(h.env, aid, key, stamp + 2 * DAY)).toBe(false);
  expect(await h.bucket.head(key)).toBeNull();
});

it("starts purging promptly, skips empty young tombstones, and sweeps abandoned objects", async () => {
  const owner = await h.login("owner@example.test"),
    stamp = Date.now(),
    groups = [];
  for (let n = 0; n < 2; n++) {
    const gid = await h.group(owner),
      issue = await h.issue(owner, gid);
    const upload = await h.request(
      "/api/groups/" + gid + "/issues/" + issue.id + "/assets",
      {
        method: "POST",
        client: owner,
        headers: { "Content-Type": "image/jpeg" },
        raw: jpeg,
      },
    );
    expect(upload.status).toBe(201);
    expect(
      (
        await h.request("/api/groups/" + gid, {
          method: "DELETE",
          client: owner,
          body: { name: "Test circle" },
        })
      ).status,
    ).toBe(200);
    groups.push(gid);
  }
  for (let n = 0; n < 3; n++) await runCleanup(h.env, stamp + 60000 * (n + 1));
  for (const gid of groups) {
    expect(
      await h.db
        .prepare("SELECT COUNT(*) AS n FROM issues WHERE group_id=?")
        .bind(gid)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await h.db.prepare("SELECT id FROM groups WHERE id=?").bind(gid).first(),
    ).not.toBeNull();
  }
  for (let n = 0; n < 30; n++)
    await h.bucket.put(groups[0] + "/abandoned-" + n, jpeg);
  for (let n = 0; n < 4; n++)
    await runCleanup(h.env, stamp + 29 * DAY + (n + 1) * 60000);
  for (const gid of groups)
    expect(
      await h.db.prepare("SELECT id FROM groups WHERE id=?").bind(gid).first(),
    ).toBeNull();
  expect((await h.bucket.list()).objects).toHaveLength(0);
});

it("retains a late upload's cleanup record when R2 deletion fails", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid),
    aid = "late-failure",
    key = gid + "/" + issue.id + "/late.jpg",
    stamp = Date.now();
  await h.db
    .prepare(
      "INSERT INTO assets(id,group_id,issue_id,user_id,object_key,content_type,bytes,width,height,state,created_at) VALUES(?,?,?,?,?,'image/jpeg',?,1,1,'pending',?)",
    )
    .bind(aid, gid, issue.id, owner.id, key, jpeg.length, stamp)
    .run();
  await h.bucket.put(key, jpeg);
  await h.db
    .prepare("UPDATE issues SET state='cancelled' WHERE id=?")
    .bind(issue.id)
    .run();
  const unavailable = new Proxy(h.bucket, {
    get(target, property) {
      if (property === "delete")
        return async () => {
          throw new Error("synthetic storage outage");
        };
      return Reflect.get(target, property);
    },
  });
  await expect(
    finishPhotoUpload({ ...h.env, PHOTOS: unavailable }, aid, key),
  ).rejects.toThrow("synthetic storage outage");
  expect(
    await h.db.prepare("SELECT state FROM assets WHERE id=?").bind(aid).first(),
  ).toEqual({ state: "deleting" });
  expect(await h.bucket.head(key)).not.toBeNull();
  await runCleanup(h.env, stamp + 60000);
  expect(await h.bucket.head(key)).toBeNull();
  expect(
    await h.db.prepare("SELECT id FROM assets WHERE id=?").bind(aid).first(),
  ).toBeNull();
});

it("waits for an expired export's in-flight lease before releasing source pins", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    stamp = Date.now(),
    jid = "leased-export";
  await h.db
    .prepare(
      "INSERT INTO exports(id,user_id,group_id,kind,state,bytes,created_at,expires_at,lease_token,lease_until) VALUES(?,?,?,'group','building',100,?,?,'in-flight',?)",
    )
    .bind(jid, owner.id, gid, stamp, stamp + DAY, stamp + 120000)
    .run();
  await h.db
    .prepare(
      "INSERT INTO export_files(job_id,path,payload_json,bytes) VALUES(?,'issue.json','{}',2)",
    )
    .bind(jid)
    .run();
  await h.db
    .prepare("UPDATE groups SET deleted_at=? WHERE id=?")
    .bind(stamp - 29 * DAY - 1, gid)
    .run();
  await runCleanup(h.env, stamp);
  expect(
    await h.db
      .prepare("SELECT id FROM export_files WHERE job_id=?")
      .bind(jid)
      .first(),
  ).not.toBeNull();
  // The expired builder may still finish its last object write before returning.
  await h.bucket.put("exports/" + jid + "/buffer-late", jpeg);
  await runCleanup(h.env, stamp + 180000);
  expect(
    (await h.bucket.list({ prefix: "exports/" + jid + "/" })).objects,
  ).toHaveLength(0);
});

it("keeps export cleanup records until every deleted-group archive is removed", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    stamp = Date.now();
  for (let i = 0; i < 2; i++) {
    const jid = "deleted-export-" + i;
    await h.db
      .prepare(
        "INSERT INTO exports(id,user_id,group_id,kind,state,bytes,created_at,expires_at) VALUES(?,?,?,'group','ready',100,?,?)",
      )
      .bind(jid, owner.id, gid, stamp + i, stamp + DAY)
      .run();
    await h.db
      .prepare(
        "INSERT INTO export_files(job_id,path,payload_json,bytes) VALUES(?,'issue.json','{}',2)",
      )
      .bind(jid)
      .run();
    await h.bucket.put("exports/" + jid + "/archive.tar", "private archive");
  }
  await h.db
    .prepare("UPDATE groups SET deleted_at=? WHERE id=?")
    .bind(stamp - 29 * DAY - 1, gid)
    .run();
  for (let tick = 0; tick < 4; tick++) {
    await runCleanup(h.env, stamp + tick * 60000);
    for (const object of (await h.bucket.list({ prefix: "exports/" }))
      .objects) {
      const jid = object.key.split("/")[1];
      expect(
        await h.db
          .prepare("SELECT id FROM exports WHERE id=?")
          .bind(jid)
          .first(),
        "An archive must retain a cleanup record",
      ).not.toBeNull();
    }
  }
  expect((await h.bucket.list()).objects).toHaveLength(0);
  expect(
    await h.db.prepare("SELECT id FROM groups WHERE id=?").bind(gid).first(),
  ).toBeNull();
});

it("clears a twenty-person group's twenty-five monthly photo issues within the deletion window", async () => {
  const owner = await h.login("owner@example.test"),
    gid = await h.group(owner),
    stamp = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (let member = 1; member < 20; member++) {
    statements.push(
      h.db
        .prepare("INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)")
        .bind(
          "friend-" + member,
          "friend-" + member + "@example.test",
          "Friend",
          stamp - 800 * DAY,
        ),
    );
    statements.push(
      h.db
        .prepare(
          "INSERT INTO memberships(group_id,user_id,role,joined_at) VALUES(?,?,'member',?)",
        )
        .bind(gid, "friend-" + member, stamp - 800 * DAY),
    );
  }
  for (let issue = 0; issue < 25; issue++) {
    const iid = "history-" + issue,
      created = stamp - (800 - issue * 30) * DAY;
    statements.push(
      h.db
        .prepare(
          "INSERT INTO issues(id,group_id,title,state,opens_at,deadline,delivery_at,reminder_at,created_at) VALUES(?,?,'History','published',?,?,?,?,?)",
        )
        .bind(iid, gid, created, created, created, created, created),
    );
    const contributors = [];
    for (let member = 0; member < 20; member++) {
      const uid = member ? "friend-" + member : owner.id,
        photos = [];
      for (let photo = 0; photo < 3; photo++) {
        const aid = iid + "-" + member + "-" + photo,
          key = gid + "/" + iid + "/" + aid + ".jpg";
        statements.push(
          h.db
            .prepare(
              "INSERT INTO assets(id,group_id,issue_id,user_id,object_key,content_type,bytes,width,height,state,created_at) VALUES(?,?,?,?,?,'image/jpeg',?,1,1,'ready',?)",
            )
            .bind(aid, gid, iid, uid, key, jpeg.length, created),
        );
        await h.bucket.put(key, jpeg);
        photos.push({ id: aid, caption: "A memory" });
      }
      contributors.push({
        id: uid,
        name: "Friend",
        update: { answers: {}, photos, good: "", shoutout: "" },
      });
    }
    const content = {
      schemaVersion: 1,
      groupName: "History",
      title: "History",
      questions: [],
      contributors,
    };
    statements.push(
      h.db
        .prepare(
          "INSERT INTO publications(issue_id,group_id,content_json,published_at) VALUES(?,?,?,?)",
        )
        .bind(iid, gid, JSON.stringify(content), created),
    );
  }
  for (let i = 0; i < statements.length; i += 50)
    await h.db.batch(statements.slice(i, i + 50));
  await h.db
    .prepare("UPDATE groups SET deleted_at=? WHERE id=?")
    .bind(stamp - 29 * DAY - 1, gid)
    .run();
  for (let tick = 0; tick < 65; tick++)
    await runCleanup(h.env, stamp + tick * 60000);
  expect(
    await h.db
      .prepare("SELECT COUNT(*) AS n FROM assets WHERE group_id=?")
      .bind(gid)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await h.db
      .prepare("SELECT COUNT(*) AS n FROM issues WHERE group_id=?")
      .bind(gid)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await h.db.prepare("SELECT id FROM groups WHERE id=?").bind(gid).first(),
  ).toBeNull();
  expect((await h.bucket.list({ prefix: gid + "/" })).objects).toHaveLength(0);
  expect(
    (await h.db.prepare("PRAGMA foreign_key_check").all()).results,
  ).toHaveLength(0);
}, 60000);
