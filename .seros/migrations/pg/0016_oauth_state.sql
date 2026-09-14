-- 0016: durable, single-use OAuth state for serverless callbacks.
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_at ON oauth_states (expires_at);
