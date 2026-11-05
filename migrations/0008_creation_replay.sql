ALTER TABLE issues ADD COLUMN creation_key TEXT;
CREATE UNIQUE INDEX issues_creation_key ON issues(creation_key) WHERE creation_key IS NOT NULL;
ALTER TABLE exports ADD COLUMN creation_key TEXT;
CREATE UNIQUE INDEX exports_creation_key ON exports(creation_key) WHERE creation_key IS NOT NULL;
ALTER TABLE email_outbox ADD COLUMN reminder_deadline INTEGER;
UPDATE email_outbox SET reminder_deadline=(SELECT deadline FROM issues WHERE id=email_outbox.issue_id) WHERE kind='reminder' AND state IN ('queued','sending');
UPDATE email_outbox SET logical_key=issue_id||':reminder:'||reminder_deadline||':'||user_id WHERE kind='reminder' AND reminder_deadline IS NOT NULL AND logical_key=issue_id||':reminder:'||user_id;
