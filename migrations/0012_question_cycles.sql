ALTER TABLE groups ADD COLUMN bank_question_count INTEGER NOT NULL DEFAULT 1 CHECK(bank_question_count BETWEEN 0 AND 5);
ALTER TABLE groups ADD COLUMN question_reminder_hours INTEGER NOT NULL DEFAULT 24 CHECK(question_reminder_hours BETWEEN 0 AND 168);
ALTER TABLE groups ADD COLUMN reminder_image_id TEXT;
ALTER TABLE memberships ADD COLUMN notify_questions INTEGER NOT NULL DEFAULT 1;
ALTER TABLE questions ADD COLUMN used_issue_id TEXT;
ALTER TABLE questions ADD COLUMN source TEXT NOT NULL DEFAULT 'member';
ALTER TABLE issue_questions ADD COLUMN bank_id TEXT;
ALTER TABLE issue_questions ADD COLUMN source_question_id TEXT;
CREATE INDEX issue_question_bank ON issue_questions(group_id,bank_id);
UPDATE questions SET source='bank',selected=0 WHERE text IN ('What has been a small bright spot lately?', 'What are you looking forward to?', 'What’s something you’d love us to do together?') AND EXISTS(SELECT 1 FROM groups g WHERE g.id=questions.group_id AND g.owner_id=questions.author_id AND g.created_at=questions.created_at);
UPDATE questions SET used_issue_id=(SELECT iq.issue_id FROM issue_questions iq WHERE iq.group_id=questions.group_id AND iq.text=questions.text AND iq.author_id=questions.author_id LIMIT 1),selected=0 WHERE EXISTS(SELECT 1 FROM issue_questions iq WHERE iq.group_id=questions.group_id AND iq.text=questions.text AND iq.author_id=questions.author_id);
UPDATE questions SET selected=1 WHERE source='member' AND used_issue_id IS NULL;
UPDATE issue_questions SET bank_id=CASE text WHEN 'What has been a small bright spot lately?' THEN 'bank-1' WHEN 'What are you looking forward to?' THEN 'bank-2' WHEN 'What’s something you’d love us to do together?' THEN 'bank-3' END WHERE text IN ('What has been a small bright spot lately?', 'What are you looking forward to?', 'What’s something you’d love us to do together?');
UPDATE groups SET reminder_offsets_json='[24]' WHERE reminder_offsets_json='[48]';
UPDATE issues SET reminder_offsets_json='[24]',reminder_at=deadline-86400000,reminder_index=0 WHERE state IN ('scheduled','open') AND reminded_at IS NULL AND reminder_offsets_json='[48]';
CREATE TABLE email_outbox_new (
 id TEXT PRIMARY KEY, logical_key TEXT NOT NULL UNIQUE, group_id TEXT REFERENCES groups(id), issue_id TEXT REFERENCES issues(id),
 user_id TEXT NOT NULL REFERENCES users(id), recipient TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('login','opening','reminder','publication','email_change','transfer','question_reminder')),
 reminder_deadline INTEGER, payload TEXT, expires_at INTEGER, state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','accepted','failed','uncertain','skipped')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT,
 provider_id TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO email_outbox_new (id,logical_key,group_id,issue_id,user_id,recipient,kind,reminder_deadline,payload,expires_at,state,attempts,next_attempt,lease_until,lease_token,provider_id,error_code,created_at,updated_at) SELECT id,logical_key,group_id,issue_id,user_id,recipient,kind,reminder_deadline,payload,expires_at,state,attempts,next_attempt,lease_until,lease_token,provider_id,error_code,created_at,updated_at FROM email_outbox;
DROP TABLE email_outbox;
ALTER TABLE email_outbox_new RENAME TO email_outbox;
CREATE INDEX outbox_due ON email_outbox(state,next_attempt);
CREATE TRIGGER mail_state_audit AFTER UPDATE OF state ON email_outbox WHEN OLD.state!=NEW.state BEGIN INSERT INTO audit_events(id,group_id,action,target,created_at,details_json) VALUES(lower(hex(randomblob(16))),NEW.group_id,'mail.state_changed',NEW.id,unixepoch('subsec')*1000,json_object('from',OLD.state,'to',NEW.state,'error_code',CASE WHEN NEW.error_code IS NULL THEN NULL WHEN NEW.error_code IN ('E_RECIPIENT_SUPPRESSED','E_RECIPIENT_NOT_VERIFIED','E_CONFIGURATION','E_RATE_LIMITED','E_DAILY_LIMIT_EXCEEDED','UNKNOWN_SEND_RESULT','lease_expired','expired','delivery_window_expired','ineligible_recipient','membership_or_preference','issue_or_submission_changed','question_window_changed','mail_not_configured','publication_missing','message_preparation_failed','issue_changed','group_deleted','superseded') THEN NEW.error_code ELSE 'redacted_error' END)); END;
