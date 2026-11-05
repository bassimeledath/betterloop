ALTER TABLE issues ADD COLUMN cancelled_at INTEGER;
UPDATE issues SET cancelled_at=created_at WHERE state='cancelled';
