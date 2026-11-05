ALTER TABLE groups ADD COLUMN reminder_offsets_json TEXT NOT NULL DEFAULT '[48]';
ALTER TABLE issues ADD COLUMN reminder_offsets_json TEXT NOT NULL DEFAULT '[48]';
ALTER TABLE issues ADD COLUMN reminder_index INTEGER NOT NULL DEFAULT 0;
UPDATE issues SET reminder_index=1 WHERE reminded_at IS NOT NULL;
UPDATE email_outbox SET logical_key=issue_id||':reminder:'||reminder_deadline||':'||(reminder_deadline-172800000)||':'||user_id WHERE kind='reminder' AND reminder_deadline IS NOT NULL;
