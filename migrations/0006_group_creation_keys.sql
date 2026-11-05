ALTER TABLE groups ADD COLUMN creation_key TEXT;
CREATE UNIQUE INDEX groups_creation_key ON groups(creation_key) WHERE creation_key IS NOT NULL;
