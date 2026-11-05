CREATE TABLE group_join_links (group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,token_ciphertext TEXT,enabled INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL);
CREATE TABLE join_signups (id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,link_hash TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE,name TEXT NOT NULL,ticket_hash TEXT NOT NULL UNIQUE,ticket_ciphertext TEXT NOT NULL,request_id TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'starting',check_after INTEGER NOT NULL DEFAULT 0,enroll_attempted_at INTEGER,login_queued_at INTEGER,login_token_hash TEXT,joined_at INTEGER,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,UNIQUE(group_id,request_id));
CREATE INDEX join_signup_email ON join_signups(email,expires_at);
ALTER TABLE login_tokens ADD COLUMN join_signup_id TEXT;
ALTER TABLE email_destinations ADD COLUMN provider_id TEXT;
ALTER TABLE memberships ADD COLUMN shared_join_blocked INTEGER NOT NULL DEFAULT 0;
UPDATE memberships SET shared_join_blocked=1 WHERE active=0;
