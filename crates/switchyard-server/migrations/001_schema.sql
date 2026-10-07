CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  project_id uuid REFERENCES projects ON DELETE CASCADE,
  user_id uuid REFERENCES users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','editor','viewer')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE environments (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  protected boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (project_id, key)
);

CREATE TABLE flags (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  key text NOT NULL,
  type text NOT NULL CHECK (type IN ('bool','string')),
  description text NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);

CREATE TABLE flag_configs (
  flag_id uuid REFERENCES flags ON DELETE CASCADE,
  environment_id uuid REFERENCES environments ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  off_value jsonb NOT NULL,
  fallthrough jsonb NOT NULL,
  rules jsonb NOT NULL DEFAULT '[]',
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users,
  PRIMARY KEY (flag_id, environment_id)
);

CREATE TABLE sdk_keys (
  id uuid PRIMARY KEY,
  environment_id uuid NOT NULL REFERENCES environments ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL,
  environment_id uuid,
  flag_key text,
  actor_id uuid NOT NULL,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_project_idx ON audit_log (project_id, id DESC);
