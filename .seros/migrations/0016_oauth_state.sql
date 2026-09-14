-- 0016: durable, single-use OAuth state for serverless callbacks.
-- State contains only an encrypted-at-rest-free opaque key and tenant/member ids;
-- no provider token or message content is stored here.
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_at ON oauth_states (expires_at);
