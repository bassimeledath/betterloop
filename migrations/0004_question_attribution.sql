ALTER TABLE issue_questions ADD COLUMN author_id TEXT REFERENCES users(id);
