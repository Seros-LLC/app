-- SER-9: the workspace/billing tier dimension carried by every
-- OPERATIONS-CHECKLIST section 7 instrumentation event.
--
-- This is NOT the provider model tier (cheap/standard/careful), which is a
-- cost-routing knob in action_meter and says nothing about what a customer pays.
-- Default 'trial': a workspace that has never been billed is on trial.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS billing_tier TEXT NOT NULL DEFAULT 'trial';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_billing_tier_check'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_billing_tier_check
      CHECK (billing_tier IN ('trial','starter','team','scale'));
  END IF;
END $$;
