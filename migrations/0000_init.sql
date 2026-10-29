CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  admin_password_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS signups (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_shifts_plan ON shifts(plan_id);
CREATE INDEX IF NOT EXISTS idx_signups_shift ON signups(shift_id);
CREATE INDEX IF NOT EXISTS idx_versions_plan ON versions(plan_id);
