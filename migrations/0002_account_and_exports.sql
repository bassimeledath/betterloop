ALTER TABLE users ADD COLUMN remove_content INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deletion_records ADD COLUMN cursor TEXT NOT NULL DEFAULT '';
ALTER TABLE deletion_records ADD COLUMN completed_at INTEGER;
CREATE TABLE email_changes (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), new_email TEXT NOT NULL COLLATE NOCASE,
 expires_at INTEGER NOT NULL, used_at INTEGER, claim_key TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX email_changes_user ON email_changes(user_id,expires_at);
CREATE TABLE exports (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), group_id TEXT REFERENCES groups(id),
 kind TEXT NOT NULL CHECK(kind IN ('group','personal')), state TEXT NOT NULL DEFAULT 'planning' CHECK(state IN ('planning','building','ready','failed','expired')),
 source_cursor TEXT NOT NULL DEFAULT '', file_cursor INTEGER NOT NULL DEFAULT 0,
 upload_id TEXT, buffer_key TEXT, parts_json TEXT NOT NULL DEFAULT '[]', bytes INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_until INTEGER, revision INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX exports_work ON exports(state,created_at);
CREATE TABLE export_files (
 id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
 path TEXT NOT NULL, payload_json TEXT, asset_id TEXT REFERENCES assets(id), bytes INTEGER NOT NULL,
 UNIQUE(job_id,path)
);
CREATE INDEX export_files_job ON export_files(job_id,id);
CREATE TRIGGER account_deletion_owner_guard BEFORE UPDATE OF deleted_at ON users WHEN NEW.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM groups WHERE owner_id=NEW.id AND deleted_at IS NULL) BEGIN SELECT RAISE(ABORT,'transfer_owned_groups_first'); END;
