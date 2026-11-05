import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
it("restores cover and thumbnail BLOBs with SQL statements below the D1 limit", async () => {
  const dir = await mkdtemp(resolve("work", "cover-restore-"));
  try {
    const schema = (
      await Promise.all(
        (await readdir("migrations"))
          .filter((f) => f.endsWith(".sql"))
          .sort()
          .map((f) => readFile("migrations/" + f, "utf8")),
      )
    ).join("\n");
    await writeFile(join(dir, "schema.sql"), schema);
    const setup = `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript(open(sys.argv[2]).read());c.execute("INSERT INTO users(id,email,name,created_at) VALUES('u','u@example.test','User',1)");c.execute("INSERT INTO groups(id,name,owner_id,cadence,recurrence_json,next_delivery,created_at,cover_id) VALUES('g','Group','u','monthly','{}',1,1,'cover')");c.execute("INSERT INTO group_covers(id,group_id,data,caption,width,height,created_at) VALUES('cover','g',?,'Cover',1200,600,1)",(bytes(range(256))*768,));c.execute("INSERT INTO issues(id,group_id,title,opens_at,deadline,delivery_at,state,reminder_at,created_at) VALUES('i','g','Issue',1,2,2,'open',1,1)");c.execute("INSERT INTO assets(id,group_id,issue_id,user_id,object_key,content_type,bytes,width,height,state,created_at,email_data) VALUES('a','g','i','u','photo','image/jpeg',1,1,1,'ready',1,?)",(bytes(range(256))*384,));c.commit()`;
    await run("python3", [
      "-c",
      setup,
      join(dir, "source.sqlite"),
      join(dir, "schema.sql"),
    ]);
    await run("python3", [
      "scripts/restore_sql.py",
      join(dir, "source.sqlite"),
      join(dir, "restore.sql"),
    ]);
    const sql = await readFile(join(dir, "restore.sql"), "utf8");
    expect(Math.max(...sql.split("\n").map((l) => l.length))).toBeLessThan(
      100000,
    );
    await run("python3", [
      "-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript(open(sys.argv[2]).read());assert c.execute("SELECT data FROM group_covers").fetchone()[0]==bytes(range(256))*768;assert c.execute("SELECT email_data FROM assets").fetchone()[0]==bytes(range(256))*384;assert c.execute("PRAGMA foreign_key_check").fetchall()==[]`,
      join(dir, "restored.sqlite"),
      join(dir, "restore.sql"),
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
