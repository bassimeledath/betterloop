import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
it("migrates live question copies and draft keys without losing queue records or the mail audit trigger", async () => {
  const dir = await mkdtemp(resolve("work", "question-migration-"));
  try {
    const files = (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const schema = (
      await Promise.all(
        files
          .filter((f) => f < "0012")
          .map((f) => readFile("migrations/" + f, "utf8")),
      )
    ).join("\n");
    await writeFile(join(dir, "before.sql"), schema);
    await writeFile(
      join(dir, "migration.sql"),
      await readFile("migrations/0012_question_cycles.sql", "utf8"),
    );
    const script = `import sqlite3,sys,json
c=sqlite3.connect(':memory:');c.executescript(open(sys.argv[1]).read())
c.execute("INSERT INTO users(id,email,name,created_at) VALUES('u','u@example.test','User',1)")
c.execute("INSERT INTO groups(id,name,owner_id,cadence,recurrence_json,next_delivery,created_at) VALUES('g','Group','u','weekly','{}',1,1)")
c.execute("INSERT INTO memberships(group_id,user_id,role,joined_at) VALUES('g','u','owner',1)")
c.execute("INSERT INTO questions(id,group_id,author_id,text,selected,created_at) VALUES('seed','g','u','What has been a small bright spot lately?',1,1),('asked','g','u','A member question?',1,2),('waiting','g','u','A future question?',0,3)")
c.execute("INSERT INTO issues(id,group_id,title,opens_at,deadline,delivery_at,state,reminder_at,created_at) VALUES('i','g','Issue',1,200000000,200000000,'open',1,1)")
c.execute("INSERT INTO issue_questions(id,issue_id,group_id,text,author_name,position,author_id) VALUES('q1','i','g','What has been a small bright spot lately?','User',0,'u'),('q2','i','g','A member question?','User',1,'u')")
draft=json.dumps({'answers':{'q1':'Keep my saved answer'},'photos':[],'good':'','shoutout':''})
c.execute("INSERT INTO contributions(issue_id,group_id,user_id,draft_json,updated_at) VALUES('i','g','u',?,1)",(draft,))
c.execute("INSERT INTO email_outbox(id,logical_key,user_id,recipient,kind,payload,next_attempt,created_at,updated_at) VALUES('mail','key','u','u@example.test','login','encrypted-payload',1,1,1)")
c.commit();c.executescript(open(sys.argv[2]).read())
assert c.execute("SELECT draft_json FROM contributions").fetchone()[0]==draft
assert c.execute("SELECT COUNT(*) FROM issue_questions").fetchone()[0]==2
assert c.execute("SELECT source,selected FROM questions WHERE id='seed'").fetchone()==('bank',0)
assert c.execute("SELECT used_issue_id,selected FROM questions WHERE id='asked'").fetchone()==('i',0)
assert c.execute("SELECT used_issue_id,selected FROM questions WHERE id='waiting'").fetchone()==(None,1)
assert c.execute("SELECT payload,logical_key FROM email_outbox").fetchone()==('encrypted-payload','key')
assert c.execute("SELECT reminder_at,reminder_offsets_json FROM issues").fetchone()==(113600000,'[24]')
c.execute("UPDATE email_outbox SET state='skipped',error_code='question_window_changed' WHERE id='mail'")
assert json.loads(c.execute("SELECT details_json FROM audit_events WHERE action='mail.state_changed' AND target='mail'").fetchone()[0])['error_code']=='question_window_changed'
assert c.execute('PRAGMA foreign_key_check').fetchall()==[]
print('preserved')`;
    const result = await run("python3", [
      "-c",
      script,
      join(dir, "before.sql"),
      join(dir, "migration.sql"),
    ]);
    expect(result.stdout.trim()).toBe("preserved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
