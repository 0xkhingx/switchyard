-- Lookups by member (list_projects, rbac) and expired-session purges.
-- 001/002 are applied migrations and must never be edited; add new files.
CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON memberships (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
