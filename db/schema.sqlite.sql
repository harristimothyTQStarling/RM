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

CREATE TABLE IF NOT EXISTS bill_rate (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario      TEXT NOT NULL DEFAULT 'baseline',
  resource_key  TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  rate          REAL NOT NULL CHECK (rate > 0),
  updated_by    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  UNIQUE (scenario, resource_key, target_key)
);

CREATE TABLE IF NOT EXISTS tbh (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario    TEXT NOT NULL DEFAULT 'baseline',
  tbh_key     TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT '',
  dept        TEXT NOT NULL DEFAULT '',
  shore       TEXT NOT NULL DEFAULT '',   -- see db/schema.postgres.sql

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

CREATE TABLE IF NOT EXISTS proposed_hire (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario     TEXT NOT NULL DEFAULT 'baseline',
  resource_key TEXT NOT NULL,
  target_key   TEXT NOT NULL,
  name         TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (scenario, resource_key, target_key)
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

-- Planner Assistant trail: every write the agent proposed and what the user
-- decided. The data change itself is audited in audit_log by the stores (actor
-- = the signed-in user); this table adds the "via assistant" attribution.
CREATE TABLE IF NOT EXISTS agent_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  actor    TEXT NOT NULL,
  tool     TEXT NOT NULL,
  input    TEXT,
  decision TEXT NOT NULL,            -- 'approved' | 'declined'
  status   INTEGER,                  -- HTTP status of the execution; NULL if declined
  result   TEXT
);
CREATE INDEX IF NOT EXISTS IX_AgentLog_at ON agent_log (at DESC);

-- ---------------------------------------------------------------------------
-- Odoo reference cache (mirrors the ref_* tables in db/schema.postgres.sql).
-- Cached rather than queried live so a page load never blocks on Odoo and the
-- app keeps working if Odoo is briefly unreachable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref_person (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT '',
  dept      TEXT NOT NULL DEFAULT '',
  type      TEXT NOT NULL DEFAULT 'employee',
  active    INTEGER NOT NULL DEFAULT 1,
  hire_date TEXT                             -- earliest hr_version.date_version (YYYY-MM-DD)
);

-- Company-wide public holidays (resource_calendar_leaves rows with no resource,
-- time_type='leave'). Used to prorate monthly capacity, matching the board-pack
-- utilization basis: available = 8h x weekdays - company holidays.
CREATE TABLE IF NOT EXISTS ref_holiday (
  id        INTEGER PRIMARY KEY,             -- odoo resource_calendar_leaves.id
  name      TEXT NOT NULL DEFAULT '',
  date_from TEXT NOT NULL,                   -- YYYY-MM-DD
  date_to   TEXT NOT NULL
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
  active INTEGER NOT NULL DEFAULT 1,
  -- see db/schema.postgres.sql: closed opp whose forecast has no matching project yet
  needs_project INTEGER NOT NULL DEFAULT 0,
  expected_start  TEXT,                     -- CRM expected start date (YYYY-MM-DD)
  expected_months INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ref_actual (
  employee_id INTEGER NOT NULL,
  project_id  INTEGER NOT NULL,
  month       TEXT NOT NULL,
  hours       REAL NOT NULL,
  bill_rate   REAL NOT NULL DEFAULT 0,   -- see db/schema.postgres.sql
  revenue     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, project_id, month)
);

-- Fully loaded per-person monthly cost (salary + bonus + employer taxes +
-- benefits), imported from Gusto reporting by the costing role. Only served to
-- COSTING_UPNS. kind: 'actual' for closed months, 'standard' (trailing-average
-- forward rate) for current and future months.
CREATE TABLE IF NOT EXISTS ref_cost (
  employee_id INTEGER NOT NULL,      -- Odoo person id (ref_person.id)
  month       TEXT NOT NULL,         -- 'YYYY-MM-01'
  cost        REAL NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'actual',
  PRIMARY KEY (employee_id, month)
);

CREATE TABLE IF NOT EXISTS sync_state (
  source    TEXT PRIMARY KEY,
  synced_at TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  ok        INTEGER NOT NULL DEFAULT 1,
  message   TEXT
);
