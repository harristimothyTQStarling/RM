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

-- Bill rate for a resource on a specific target (person x project/opportunity).
-- One rate per pair, not per month: the $ view multiplies planned hours by it.
-- rate = 0 never stored; clearing a rate deletes the row.
CREATE TABLE IF NOT EXISTS bill_rate (
  id            SERIAL PRIMARY KEY,
  scenario      VARCHAR(64)  NOT NULL DEFAULT 'baseline',
  resource_key  VARCHAR(64)  NOT NULL,
  target_key    VARCHAR(64)  NOT NULL,
  rate          NUMERIC(8,2) NOT NULL CHECK (rate > 0),
  updated_by    VARCHAR(128) NOT NULL,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  version       INT          NOT NULL DEFAULT 1,
  UNIQUE (scenario, resource_key, target_key)
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
  -- 'onshore' | 'offshore' — part of a TBA pool's identity (the same role on
  -- and offshore are DIFFERENT pools). '' means not yet classified; the boot
  -- normalizer infers it for historical rows (avg bill rate < $100 => offshore).
  shore        VARCHAR(16)  NOT NULL DEFAULT '',
  start_month  DATE,
  capacity     NUMERIC(7,2),
  updated_by   VARCHAR(128) NOT NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  version      INT          NOT NULL DEFAULT 1,
  UNIQUE (scenario, tbh_key)
);
ALTER TABLE tbh ADD COLUMN IF NOT EXISTS shore VARCHAR(16) NOT NULL DEFAULT '';

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

-- Proposed hire per (TBA role pool × project): the candidate's name typed in by
-- an editor before they exist in Odoo. Free text, last-write-wins (audited);
-- cleared automatically when the pair's forecast is shifted to a real person.
CREATE TABLE IF NOT EXISTS proposed_hire (
  id           SERIAL PRIMARY KEY,
  scenario     VARCHAR(64)  NOT NULL DEFAULT 'baseline',
  resource_key VARCHAR(64)  NOT NULL,
  target_key   VARCHAR(64)  NOT NULL,
  name         VARCHAR(128) NOT NULL,
  updated_by   VARCHAR(128) NOT NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (scenario, resource_key, target_key)
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

-- Planner Assistant trail: every write the agent proposed and what the user
-- decided. The data change itself is audited in audit_log by the stores (actor
-- = the signed-in user); this table adds the "via assistant" attribution.
CREATE TABLE IF NOT EXISTS agent_log (
  id       BIGSERIAL PRIMARY KEY,
  at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actor    VARCHAR(128) NOT NULL,
  tool     VARCHAR(64)  NOT NULL,
  input    VARCHAR(2000),
  decision VARCHAR(16)  NOT NULL,    -- 'approved' | 'declined'
  status   INT,                      -- HTTP status of the execution; NULL if declined
  result   VARCHAR(2000)
);
CREATE INDEX IF NOT EXISTS ix_agent_log_at ON agent_log (at DESC);

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
  active    SMALLINT     NOT NULL DEFAULT 1,
  hire_date DATE                                 -- earliest hr_version.date_version
);
ALTER TABLE ref_person ADD COLUMN IF NOT EXISTS hire_date DATE;

-- Company-wide public holidays (resource_calendar_leaves rows with no resource,
-- time_type='leave'). Used to prorate monthly capacity, matching the board-pack
-- utilization basis: available = 8h x weekdays - company holidays.
CREATE TABLE IF NOT EXISTS ref_holiday (
  id        INT PRIMARY KEY,                     -- odoo resource_calendar_leaves.id
  name      VARCHAR(256) NOT NULL DEFAULT '',
  date_from DATE NOT NULL,
  date_to   DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_project (
  id        INT PRIMARY KEY,                     -- odoo project_project.id
  name      VARCHAR(256) NOT NULL,
  client    VARCHAR(256) NOT NULL DEFAULT '',
  billable  SMALLINT     NOT NULL DEFAULT 1,
  active    SMALLINT     NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ref_opportunity (
  id        INT PRIMARY KEY,                     -- odoo crm_lead.id
  name      VARCHAR(256) NOT NULL,
  client    VARCHAR(256) NOT NULL DEFAULT '',
  stage     VARCHAR(64)  NOT NULL DEFAULT '',
  active    SMALLINT     NOT NULL DEFAULT 1,  -- false once Won/Lost
  -- 1 == this opportunity has CLOSED in Odoo but still carries forecast that the
  -- sync could not migrate to a delivery project (no confident match). The row is
  -- retained (active=1) so the UI can show the forecast with a "needs project"
  -- flag; each sync re-attempts the match and clears this once one is found.
  needs_project SMALLINT NOT NULL DEFAULT 0,
  -- CRM planning fields (x_studio_expected_start_date / x_studio_projected_number_
  -- of_months) used to cross-check the planner's forecast window per opportunity.
  expected_start  DATE,
  expected_months INT NOT NULL DEFAULT 0
);
-- Additive migrations for databases created before these columns existed.
ALTER TABLE ref_opportunity ADD COLUMN IF NOT EXISTS needs_project SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE ref_opportunity ADD COLUMN IF NOT EXISTS expected_start DATE;
ALTER TABLE ref_opportunity ADD COLUMN IF NOT EXISTS expected_months INT NOT NULL DEFAULT 0;

-- Actual timesheet hours for closed months, by person/project/month.
-- bill_rate is the ACTUAL realized rate from Odoo: billable revenue (hours x the
-- linked sale_order_line.price_unit) / billable hours. Hours with no SO line are
-- non-billable: they count in `hours` but not in the rate.
CREATE TABLE IF NOT EXISTS ref_actual (
  employee_id INT          NOT NULL,
  project_id  INT          NOT NULL,
  month       DATE         NOT NULL,
  hours       NUMERIC(7,2) NOT NULL,
  bill_rate   NUMERIC(8,2) NOT NULL DEFAULT 0,   -- $/hr on billed work; 0 = nothing billable
  revenue     NUMERIC(12,2) NOT NULL DEFAULT 0,  -- billable Σ(hours × price_unit)
  PRIMARY KEY (employee_id, project_id, month)
);
ALTER TABLE ref_actual ADD COLUMN IF NOT EXISTS bill_rate NUMERIC(8,2) NOT NULL DEFAULT 0;
ALTER TABLE ref_actual ADD COLUMN IF NOT EXISTS revenue NUMERIC(12,2) NOT NULL DEFAULT 0;

-- RETIRED (kept so existing databases keep their data; no endpoint reads or
-- writes it): per-month imported costs, replaced by the cost_rate card below.
CREATE TABLE IF NOT EXISTS ref_cost (
  employee_id INT           NOT NULL,   -- odoo person id (ref_person.id)
  month       DATE          NOT NULL,   -- always the 1st of the month
  cost        NUMERIC(12,2) NOT NULL,
  kind        VARCHAR(16)   NOT NULL DEFAULT 'actual',
  PRIMARY KEY (employee_id, month)
);

-- Fully loaded cost rate card per person, entered in-app by the costing role
-- (COSTING_UPNS) and only ever served to it. Any of the three may be set; the
-- client derives a month's cost as: monthly, else bi-weekly x 26/12, else
-- hourly x that month's hours.
CREATE TABLE IF NOT EXISTS cost_rate (
  employee_id INT           PRIMARY KEY,   -- odoo person id (ref_person.id)
  annual      NUMERIC(12,2),
  biweekly    NUMERIC(12,2),
  monthly     NUMERIC(12,2),
  hourly      NUMERIC(12,2),
  updated_by  VARCHAR(128)  NOT NULL,
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
ALTER TABLE cost_rate ADD COLUMN IF NOT EXISTS annual NUMERIC(12,2);

CREATE TABLE IF NOT EXISTS sync_state (
  source     VARCHAR(32) PRIMARY KEY,            -- people | projects | opportunities | actuals
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_count  INT         NOT NULL DEFAULT 0,
  ok         SMALLINT    NOT NULL DEFAULT 1,
  message    TEXT
);
