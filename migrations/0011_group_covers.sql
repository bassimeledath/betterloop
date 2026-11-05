ALTER TABLE groups ADD COLUMN cover_id TEXT;
ALTER TABLE assets ADD COLUMN email_data BLOB;
CREATE TABLE group_covers (id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,data BLOB NOT NULL CHECK(length(data)<=196608),caption TEXT NOT NULL DEFAULT '',width INTEGER NOT NULL,height INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX group_covers_group ON group_covers(group_id);
