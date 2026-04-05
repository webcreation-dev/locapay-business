-- Migration: Add submission_failed column to track failed property submissions
-- This prevents failed groupings from being reprocessed indefinitely

ALTER TABLE messages ADD COLUMN IF NOT EXISTS submission_failed BOOLEAN DEFAULT FALSE;

-- Create index for faster filtering of pending submissions
CREATE INDEX IF NOT EXISTS idx_messages_submission_failed ON messages(submission_failed) WHERE submission_failed = FALSE;
