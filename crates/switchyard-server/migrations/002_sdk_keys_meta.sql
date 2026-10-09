ALTER TABLE sdk_keys ADD COLUMN created_by uuid REFERENCES users;
ALTER TABLE sdk_keys ADD COLUMN last_used_at timestamptz;
