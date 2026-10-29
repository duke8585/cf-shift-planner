-- Optional shift end, so multi-hour shifts span several rows in the overview.
ALTER TABLE shifts ADD COLUMN end_time TEXT;
