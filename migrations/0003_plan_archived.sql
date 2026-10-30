-- Archived plans are hidden from the plan list (still reachable by link).
ALTER TABLE plans ADD COLUMN archived_at TEXT;
