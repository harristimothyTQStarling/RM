-- =============================================================================
-- TQStarling Resource Planner — Postgres schema (Railway)
-- =============================================================================
-- Applied automatically on boot by api/src/migrate.js (idempotent).
--
-- Design notes (mirrors db/schema.sqlite.sql exactly in shape and semantics so
-- the same handler + concurrency logic runs locally on SQLite and here):
--
--  * Odoo stays the system of record for people, projects, CRM and actuals.
--    This database stores the forward PLAN plus a cached copy of the Odoo
--    reference data (see the Ref* tables). Plan rows point at Odoo records by
--    id with no FK (cross-system), so the API reconciles on read.
--
--  * resource_key / target_key are composite text keys rather than nullable
--    columns: a resource is an employee OR a to-be-hired seat; a target is a
--    project OR a CRM opportunity. Nullable columns would need CHECK gymnastics
--    and break natural-key uniqueness.
--        resource_key : 'emp:110'  | 'tbh:resource-3'
--        target_key   : 'prj:119'  | 'crm:222'
--
--  * version is an explicit INT (not xmin/rowversion) so optimistic concurrency
--    is portable and testable on SQLite.
-- =============================================================================

CREATE TABLE IF NOT EXISTS allocation (
  id            SERIAL PRIMARY KEY,
  scenario      VARCHAR(64)   NOT NULL DEFAULT 'baseline',
  resource_key  VARCHAR(64)   NOT NULL,
  target_key    VARCHAR(64)   NOT NULL,
  month         DATE          NOT NULL,          -- always the 1st of the month
  hours         NUMERIC(7,2)  NOT NULL CHECK (hours >= 0),
  updated_by    VARCHAR(128)  NOT NULL,          -- signed-in email: the audit trail
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  version       INT           NOT NULL DEFAULT 1,
  UNIQUE (scenario, resource_key, target_key, month)
);
CREATE INDEX IF NOT EXISTS ix_allocation_scenario_month ON allocation (scenario, month);

CREATE TABLE IF NOT EXISTS capacity_override (
  id              SERIAL PRIMARY KEY,
  scenario        VARCHAR(64)  NOT NULL DEFAULT 'baseline',
  resource_key    VARCHAR(64)  NOT NULL,
  hours_per_month NUMERIC(7,2) NOT NULL CHECK (hours_per_month >= 0),
  updated_by      VARCHAR(128) NOT NULL,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  version         INT          NOT NULL DEFAULT 1,
  UNIQUE (scenario, resource_key)
);

-- To-be-hired seats. These have no Odoo record — this table IS their system of
-- record. dept may be empty (an open role need not have a practice).
CREATE TABLE IF NOT EXISTS tbh (
  id           SERIAL PRIMARY KEY,
  scenario     VARCHAR(64)  NOT NULL DEFAULT 'baseline',
  tbh_key      VARCHAR(64)  NOT NULL,
  name         VARCHAR(128) NOT NULL,
  role         VARCHAR(128) NOT NULL DEFAULT '',
  dept         VARCHAR(128) NOT NULL DEFAULT '',
  start_month  DATE,
  capacity     NUMERIC(7,2),
  updated_by   VARCHAR(128) NOT NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  version      INT          NOT NULL DEFAULT 1,
  UNIQUE (scenario, tbh_key)
);

-- Remembered forecast-import overrides, shared so one person's correction fixes
-- the mapping for everyone. Only MANUAL overrides are stored — auto-matches
-- re-run each import so matcher improvements are never shadowed by a stale pick.
CREATE TABLE IF NOT EXISTS import_map (
  id          SERIAL PRIMARY KEY,
  scenario    VARCHAR(64)  NOT NULL DEFAULT 'baseline',
  kind        VARCHAR(16)  NOT NULL CHECK (kind IN ('person','project')),
  source_name VARCHAR(256) NOT NULL,
  target_key  VARCHAR(64)  NOT NULL,
  updated_by  VARCHAR(128) NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (scenario, kind, source_name)
);

-- Append-only change log: row-level updated_by says who touched a cell last,
-- this says what it was before — the question actually asked when two people
-- disagree about a number.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actor       VARCHAR(128) NOT NULL,
  entity      VARCHAR(32)  NOT NULL,
  entity_key  VARCHAR(256) NOT NULL,
  action      VARCHAR(16)  NOT NULL,
  old_value   VARCHAR(64),
  new_value   VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS ix_audit_log_at ON audit_log (at DESC);

-- =============================================================================
-- Odoo reference cache
-- =============================================================================
-- Populated by the Odoo sync (api/src/odoo.js). Cached rather than queried live
-- so a page load never blocks on Odoo, and so the app keeps working if Odoo is
-- briefly unreachable. sync_state records when each set was last refreshed.

CREATE TABLE IF NOT EXISTS ref_person (
  id        INT PRIMARY KEY,                     -- odoo hr_employee.id
  name      VARCHAR(128) NOT NULL,
  role      VARCHAR(128) NOT NULL DEFAULT '',
  dept      VARCHAR(128) NOT NULL DEFAULT '',
  type      VARCHAR(16)  NOT NULL DEFAULT 'employee',   -- employee | contractor
  active    BOOLEAN      NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS ref_project (
  id        INT PRIMARY KEY,                     -- odoo project_project.id
  name      VARCHAR(256) NOT NULL,
  client    VARCHAR(256) NOT NULL DEFAULT '',
  billable  BOOLEAN      NOT NULL DEFAULT true,
  active    BOOLEAN      NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS ref_opportunity (
  id        INT PRIMARY KEY,                     -- odoo crm_lead.id
  name      VARCHAR(256) NOT NULL,
  client    VARCHAR(256) NOT NULL DEFAULT '',
  stage     VARCHAR(64)  NOT NULL DEFAULT '',
  active    BOOLEAN      NOT NULL DEFAULT true   -- false once Won/Lost
);

-- Actual timesheet hours for closed months, by person/project/month.
CREATE TABLE IF NOT EXISTS ref_actual (
  employee_id INT          NOT NULL,
  project_id  INT          NOT NULL,
  month       DATE         NOT NULL,
  hours       NUMERIC(7,2) NOT NULL,
  PRIMARY KEY (employee_id, project_id, month)
);

CREATE TABLE IF NOT EXISTS sync_state (
  source     VARCHAR(32) PRIMARY KEY,            -- people | projects | opportunities | actuals
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_count  INT         NOT NULL DEFAULT 0,
  ok         BOOLEAN     NOT NULL DEFAULT true,
  message    TEXT
);
