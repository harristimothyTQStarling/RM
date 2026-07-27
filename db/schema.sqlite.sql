-- TQStarling Resource Planner — local dev schema (SQLite).
-- Mirrors db/schema.sql exactly in shape and semantics so the SAME handler code
-- and the SAME concurrency logic run locally and on Azure SQL. Only the dialect
-- differs (INTEGER PRIMARY KEY vs IDENTITY, TEXT dates vs DATE/DATETIME2).

CREATE TABLE IF NOT EXISTS allocation (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario     TEXT NOT NULL DEFAULT 'baseline',
  resource_key TEXT NOT NULL,            -- 'emp:110' | 'tbh:resource-3'
  target_key   TEXT NOT NULL,            -- 'prj:119' | 'crm:222'
  month        TEXT NOT NULL,            -- 'YYYY-MM-01'
  hours        REAL NOT NULL CHECK (hours >= 0),
  updated_by   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (scenario, resource_key, target_key, month)
);
CREATE INDEX IF NOT EXISTS IX_Allocation_scenario_month ON allocation (scenario, month);

CREATE TABLE IF NOT EXISTS capacity_override (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario        TEXT NOT NULL DEFAULT 'baseline',
  resource_key    TEXT NOT NULL,
  hours_per_month REAL NOT NULL CHECK (hours_per_month >= 0),
  updated_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (scenario, resource_key)
);

CREATE TABLE IF NOT EXISTS tbh (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario    TEXT NOT NULL DEFAULT 'baseline',
  tbh_key     TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT '',
  dept        TEXT NOT NULL DEFAULT '',
  start_month TEXT,
  capacity    REAL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (scenario, tbh_key)
);

CREATE TABLE IF NOT EXISTS import_map (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario    TEXT NOT NULL DEFAULT 'baseline',
  kind        TEXT NOT NULL CHECK (kind IN ('person','project')),
  source_name TEXT NOT NULL,
  target_key  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (scenario, kind, source_name)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  action     TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT
);
CREATE INDEX IF NOT EXISTS IX_AuditLog_at ON audit_log (at DESC);

-- ---------------------------------------------------------------------------
-- Odoo reference cache (mirrors the ref_* tables in db/schema.postgres.sql).
-- Cached rather than queried live so a page load never blocks on Odoo and the
-- app keeps working if Odoo is briefly unreachable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref_person (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  role   TEXT NOT NULL DEFAULT '',
  dept   TEXT NOT NULL DEFAULT '',
  type   TEXT NOT NULL DEFAULT 'employee',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ref_project (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  client   TEXT NOT NULL DEFAULT '',
  billable INTEGER NOT NULL DEFAULT 1,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ref_opportunity (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  stage  TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ref_actual (
  employee_id INTEGER NOT NULL,
  project_id  INTEGER NOT NULL,
  month       TEXT NOT NULL,
  hours       REAL NOT NULL,
  PRIMARY KEY (employee_id, project_id, month)
);

CREATE TABLE IF NOT EXISTS sync_state (
  source    TEXT PRIMARY KEY,
  synced_at TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  ok        INTEGER NOT NULL DEFAULT 1,
  message   TEXT
);
