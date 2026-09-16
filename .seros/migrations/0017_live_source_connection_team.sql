-- 0017: allow a disconnected Slack team to be reclaimed.
-- Revoked connections remain stored for audit/retention, but they no longer
-- represent a live tenant and must not reserve the team id.
DROP INDEX IF EXISTS source_connections_team;
CREATE UNIQUE INDEX IF NOT EXISTS source_connections_team
  ON source_connections (provider, team_id)
  WHERE revoked_at IS NULL;
