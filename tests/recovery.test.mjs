import { it, expect } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
it("restores account data with no usable sessions, signup capabilities, mail or temporary export jobs", async () => {
  await mkdir("work", { recursive: true });
  const temp = await mkdtemp(resolve("work", "restore-policy-"));
  try {
    const schema = (
      await Promise.all(
        (await readdir("migrations"))
          .filter((n) => n.endsWith(".sql"))
          .sort()
          .map((n) => readFile(join("migrations", n), "utf8")),
      )
    ).join("\n");
    await writeFile(join(temp, "schema.sql"), schema);
    const setup = `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript(open(sys.argv[2]).read())
c.executescript("""
INSERT INTO users(id,email,name,created_at) VALUES('person','owner@example.test','Owner',1);
INSERT INTO groups(id,name,owner_id,cadence,recurrence_json,next_delivery,created_at) VALUES('group','Circle','person','monthly','{}',9999999999999,1);
INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at) VALUES('session','person','csrf',9999999999999,1);
INSERT INTO group_join_links(group_id,token_hash,token_ciphertext,created_by,created_at) VALUES('group','shared-hash','encrypted-capability','person',1);
INSERT INTO join_signups(id,group_id,link_hash,email,name,ticket_hash,ticket_ciphertext,request_id,created_at,expires_at) VALUES('signup','group','shared-hash','friend@example.test','Friend','ticket-hash','encrypted-ticket','request',1,9999999999999);
INSERT INTO login_tokens(token_hash,user_id,return_path,expires_at,created_at,join_signup_id) VALUES('login','person','encrypted-path',9999999999999,1,'signup');
INSERT INTO email_outbox(id,logical_key,user_id,recipient,kind,payload,next_attempt,created_at,updated_at) VALUES('mail','mail','person','owner@example.test','login','encrypted-mail',1,1,1);
INSERT INTO exports(id,user_id,group_id,kind,created_at,expires_at) VALUES('export','person','group','group',1,9999999999999);
""");c.commit();c.close()`;
    await run("python3", [
      "-c",
      setup,
      join(temp, "db.sqlite"),
      join(temp, "schema.sql"),
    ]);
    await run("python3", [
      "scripts/sanitize_restore.py",
      join(temp, "db.sqlite"),
    ]);
    const { stdout } = await run("python3", [
      "-c",
      `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);print(json.dumps({'sessions':c.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],'tokens':c.execute('SELECT COUNT(*) FROM login_tokens').fetchone()[0],'signups':c.execute('SELECT COUNT(*) FROM join_signups').fetchone()[0],'link':list(c.execute('SELECT enabled,token_ciphertext FROM group_join_links').fetchone()),'paused':c.execute('SELECT paused FROM groups').fetchone()[0],'mail':list(c.execute('SELECT state,payload FROM email_outbox').fetchone()),'export':list(c.execute('SELECT state,expires_at FROM exports').fetchone()),'fk':len(c.execute('PRAGMA foreign_key_check').fetchall())}))`,
      join(temp, "db.sqlite"),
    ]);
    expect(JSON.parse(stdout)).toEqual({
      sessions: 0,
      tokens: 0,
      signups: 0,
      link: [0, null],
      paused: 1,
      mail: ["skipped", null],
      export: ["expired", 0],
      fk: 0,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
