-- SER-9: first-view dedupe key for suggestion_shown.
-- A refresh must not inflate the acceptance-rate denominator.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS first_shown_at BIGINT;
