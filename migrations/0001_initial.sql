PRAGMA foreign_keys = ON;
CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
 operator INTEGER NOT NULL DEFAULT 0, group_allowance INTEGER NOT NULL DEFAULT 0,
 deleted_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE email_destinations (
 email TEXT PRIMARY KEY COLLATE NOCASE, verified INTEGER NOT NULL DEFAULT 0,
 suppressed INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE login_tokens (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 return_path TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, claim_key TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE groups (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 owner_id TEXT NOT NULL REFERENCES users(id), timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
 cadence TEXT NOT NULL CHECK(cadence IN ('weekly','fortnightly','monthly')), recurrence_json TEXT NOT NULL,
 next_delivery INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
 created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX groups_due ON groups(paused,next_delivery) WHERE deleted_at IS NULL;
CREATE TABLE memberships (
 group_id TEXT NOT NULL REFERENCES groups(id), user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), active INTEGER NOT NULL DEFAULT 1,
 notify_open INTEGER NOT NULL DEFAULT 1, notify_reminder INTEGER NOT NULL DEFAULT 1,
 notify_issue INTEGER NOT NULL DEFAULT 1, joined_at INTEGER NOT NULL,
 PRIMARY KEY(group_id,user_id)
);
CREATE INDEX memberships_user ON memberships(user_id,active);
CREATE TABLE invitations (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), email TEXT NOT NULL COLLATE NOCASE,
 token_hash TEXT NOT NULL UNIQUE, inviter_id TEXT NOT NULL REFERENCES users(id),
 expires_at INTEGER NOT NULL, accepted_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX invitations_email ON invitations(email,expires_at);
CREATE TABLE questions (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), author_id TEXT REFERENCES users(id),
 text TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
 UNIQUE(id,group_id)
);
CREATE TABLE issues (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), title TEXT NOT NULL,
 opens_at INTEGER NOT NULL, deadline INTEGER NOT NULL, delivery_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('scheduled','open','closing','published','skipped','cancelled')),
 revision INTEGER NOT NULL DEFAULT 0, reminder_at INTEGER NOT NULL, reminded_at INTEGER,
 created_at INTEGER NOT NULL, UNIQUE(group_id,delivery_at), UNIQUE(id,group_id)
);
CREATE INDEX issues_due ON issues(state,deadline,opens_at);
CREATE TABLE issue_questions (
 id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, group_id TEXT NOT NULL, text TEXT NOT NULL,
 author_name TEXT NOT NULL, position INTEGER NOT NULL,
 FOREIGN KEY(issue_id,group_id) REFERENCES issues(id,group_id), UNIQUE(id,issue_id,group_id)
);
CREATE TABLE contributions (
 issue_id TEXT NOT NULL, group_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 draft_json TEXT NOT NULL DEFAULT '{"answers":{},"photos":[],"shoutout":"","good":""}',
 submitted_json TEXT, revision INTEGER NOT NULL DEFAULT 0, submitted_at INTEGER, updated_at INTEGER NOT NULL,
 PRIMARY KEY(issue_id,user_id), FOREIGN KEY(issue_id,group_id) REFERENCES issues(id,group_id)
);
CREATE INDEX contributions_group ON contributions(group_id,user_id);
CREATE TABLE assets (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL, issue_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes<=1048576),
 width INTEGER NOT NULL, height INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','ready','deleting')),
 created_at INTEGER NOT NULL, FOREIGN KEY(issue_id,group_id) REFERENCES issues(id,group_id)
);
CREATE INDEX assets_owner ON assets(group_id,issue_id,user_id);
CREATE TABLE publications (
 issue_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 content_json TEXT NOT NULL, published_at INTEGER NOT NULL,
 FOREIGN KEY(issue_id,group_id) REFERENCES issues(id,group_id)
);
CREATE TABLE email_outbox (
 id TEXT PRIMARY KEY, logical_key TEXT NOT NULL UNIQUE, group_id TEXT REFERENCES groups(id), issue_id TEXT REFERENCES issues(id),
 user_id TEXT NOT NULL REFERENCES users(id), recipient TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('login','opening','reminder','publication','email_change','transfer')),
 payload TEXT, expires_at INTEGER, state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','accepted','failed','uncertain','skipped')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT,
 provider_id TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX outbox_due ON email_outbox(state,next_attempt);
CREATE TABLE captured_emails (
 id TEXT PRIMARY KEY, recipient TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL,
 text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY, actor_id TEXT, group_id TEXT, action TEXT NOT NULL, target TEXT, metadata_json TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX audit_group ON audit_events(group_id,created_at);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE transfers (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), from_user TEXT NOT NULL REFERENCES users(id),
 to_user TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, accepted_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE deletion_records (id TEXT PRIMARY KEY, user_id TEXT, group_id TEXT, scope TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE service_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
