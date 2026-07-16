/* =============================================================================
   TQStarling Resource Planner — Azure SQL schema
   =============================================================================
   Design notes:

   * Odoo stays the system of record for people, projects, CRM and actuals.
     This database stores ONLY the forward plan. Rows point at Odoo records by
     id; there is deliberately no FK (cross-system), so the API reconciles on
     read and drops orphans — the same way the spreadsheet import already does.

   * resource_key / target_key are composite text keys rather than nullable
     employee_ref / project_ref / lead_ref columns. Reason: a resource is either
     an Odoo employee OR a to-be-hired placeholder, and a target is either a
     project OR a CRM opportunity. Nullable columns would need CHECK gymnastics,
     and SQL Server's UNIQUE treats NULLs as equal (permitting only one NULL row)
     which would break the natural key outright.
         resource_key : 'emp:110'  | 'tbh:resource-3'
         target_key   : 'prj:119'  | 'crm:222'

   * version is an explicit INT, not SQL Server's rowversion. Same optimistic
     concurrency semantics, but portable — the local dev stack runs the identical
     logic on SQLite, so concurrency is testable without an Azure dependency.

   * scenario supports what-if planning ("what if we win Medtronic?"). Costs
     nothing now; retrofitting it later would mean touching every row and query.
   ============================================================================= */

IF OBJECT_ID('dbo.Allocation', 'U') IS NULL
CREATE TABLE dbo.Allocation (
  id            INT IDENTITY(1,1) PRIMARY KEY,
  scenario      VARCHAR(64)   NOT NULL CONSTRAINT DF_Alloc_scenario DEFAULT 'baseline',
  resource_key  VARCHAR(64)   NOT NULL,   -- 'emp:<odoo hr_employee.id>' | 'tbh:<key>'
  target_key    VARCHAR(64)   NOT NULL,   -- 'prj:<odoo project.id>'     | 'crm:<odoo crm_lead.id>'
  month         DATE          NOT NULL,   -- always the 1st of the month
  hours         DECIMAL(7,2)  NOT NULL CONSTRAINT CK_Alloc_hours CHECK (hours >= 0),
  updated_by    VARCHAR(128)  NOT NULL,   -- M365 UPN — the audit trail
  updated_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_Alloc_updated DEFAULT SYSUTCDATETIME(),
  version       INT           NOT NULL CONSTRAINT DF_Alloc_version DEFAULT 1,
  CONSTRAINT UQ_Allocation UNIQUE (scenario, resource_key, target_key, month)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_Allocation_scenario_month')
CREATE INDEX IX_Allocation_scenario_month ON dbo.Allocation (scenario, month) INCLUDE (resource_key, target_key, hours);
GO

/* Per-person monthly capacity override (default lives in app config, not here). */
IF OBJECT_ID('dbo.CapacityOverride', 'U') IS NULL
CREATE TABLE dbo.CapacityOverride (
  id              INT IDENTITY(1,1) PRIMARY KEY,
  scenario        VARCHAR(64)  NOT NULL CONSTRAINT DF_Cap_scenario DEFAULT 'baseline',
  resource_key    VARCHAR(64)  NOT NULL,
  hours_per_month DECIMAL(7,2) NOT NULL CONSTRAINT CK_Cap_hours CHECK (hours_per_month >= 0),
  updated_by      VARCHAR(128) NOT NULL,
  updated_at      DATETIME2(0) NOT NULL CONSTRAINT DF_Cap_updated DEFAULT SYSUTCDATETIME(),
  version         INT          NOT NULL CONSTRAINT DF_Cap_version DEFAULT 1,
  CONSTRAINT UQ_CapacityOverride UNIQUE (scenario, resource_key)
);
GO

/* To-be-hired placeholders. These have no Odoo record — this table IS their
   system of record. dept may be empty (an open role need not have a practice). */
IF OBJECT_ID('dbo.Tbh', 'U') IS NULL
CREATE TABLE dbo.Tbh (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  scenario     VARCHAR(64)  NOT NULL CONSTRAINT DF_Tbh_scenario DEFAULT 'baseline',
  tbh_key      VARCHAR(64)  NOT NULL,
  name         VARCHAR(128) NOT NULL,
  role         VARCHAR(128) NOT NULL CONSTRAINT DF_Tbh_role DEFAULT '',
  dept         VARCHAR(128) NOT NULL CONSTRAINT DF_Tbh_dept DEFAULT '',
  start_month  DATE         NULL,
  capacity     DECIMAL(7,2) NULL,
  updated_by   VARCHAR(128) NOT NULL,
  updated_at   DATETIME2(0) NOT NULL CONSTRAINT DF_Tbh_updated DEFAULT SYSUTCDATETIME(),
  version      INT          NOT NULL CONSTRAINT DF_Tbh_version DEFAULT 1,
  CONSTRAINT UQ_Tbh UNIQUE (scenario, tbh_key)
);
GO

/* Remembered forecast-import overrides. Previously per-browser localStorage;
   shared here so one person's correction fixes the mapping for everyone.
   Only MANUAL overrides are stored — auto-matches re-run each import so
   matcher improvements are never shadowed by a stale pick. */
IF OBJECT_ID('dbo.ImportMap', 'U') IS NULL
CREATE TABLE dbo.ImportMap (
  id          INT IDENTITY(1,1) PRIMARY KEY,
  scenario    VARCHAR(64)  NOT NULL CONSTRAINT DF_Imp_scenario DEFAULT 'baseline',
  kind        VARCHAR(16)  NOT NULL CONSTRAINT CK_Imp_kind CHECK (kind IN ('person','project')),
  source_name VARCHAR(256) NOT NULL,   -- the string as it appears in the workbook
  target_key  VARCHAR(64)  NOT NULL,   -- 'emp:110' | 'tbh:x' | 'prj:119' | 'crm:222' | 'skip'
  updated_by  VARCHAR(128) NOT NULL,
  updated_at  DATETIME2(0) NOT NULL CONSTRAINT DF_Imp_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_ImportMap UNIQUE (scenario, kind, source_name)
);
GO

/* Append-only change log. Row-level updated_by tells you who touched a cell last;
   this tells you what it was before — the question that actually gets asked when
   two people disagree about a number. */
IF OBJECT_ID('dbo.AuditLog', 'U') IS NULL
CREATE TABLE dbo.AuditLog (
  id          BIGINT IDENTITY(1,1) PRIMARY KEY,
  at          DATETIME2(0) NOT NULL CONSTRAINT DF_Audit_at DEFAULT SYSUTCDATETIME(),
  actor       VARCHAR(128) NOT NULL,
  entity      VARCHAR(32)  NOT NULL,   -- 'allocation' | 'capacity' | 'tbh' | 'importmap'
  entity_key  VARCHAR(256) NOT NULL,
  action      VARCHAR(16)  NOT NULL,   -- 'insert' | 'update' | 'delete'
  old_value   VARCHAR(64)  NULL,
  new_value   VARCHAR(64)  NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_AuditLog_at')
CREATE INDEX IX_AuditLog_at ON dbo.AuditLog (at DESC);
GO
