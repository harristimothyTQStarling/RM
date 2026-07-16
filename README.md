# TQStarling Resource Planner

Shared, multi-user resource planning for calendar-year staffing: allocate hours per
person per project per month, and see utilization by employee, role and customer.

Replaces the single-user browser tool. One link, one plan, real persistence.

---

## Architecture

```
  Browser (web/)                 Azure Static Web Apps
        │  Entra ID sign-in  ──────────────┐
        ▼                                  │
   /api/*  ──►  Azure Functions (api/)  ───┤
                    │                      │
                    ├──► Azure SQL Basic  ─┘   the PLAN  (read/write)
                    │       Managed Identity — no password
                    │
                    └──► Odoo (read-only)      people · projects · CRM · actuals
```

**Odoo stays the system of record** for people, projects, CRM pipeline and timesheet
actuals. This app reads it and never writes to it — so it cannot corrupt the ERP, and
you only need a **read-only** service account (far easier to get approved than write
access plus a schema change).

**Azure SQL stores only the forward plan.** Roughly 2–4k rows a year — Basic tier is
~1% utilised and costs about $5/month.

### Deliberate decisions

| Decision | Why |
|---|---|
| `resource_key` / `target_key` composite text keys | A resource is an employee **or** a to-be-hired placeholder; a target is a project **or** a CRM opportunity. Nullable FK columns would need CHECK gymnastics, and SQL Server's UNIQUE treats NULLs as equal — permitting only one NULL row and breaking the natural key. |
| Explicit `version INT`, not `rowversion` | Same optimistic-concurrency semantics, but portable — the identical logic runs on SQLite locally, so concurrency is testable with no Azure dependency. |
| `scenario` column from day one | Enables what-if planning ("what if we win Medtronic?"). Free now; retrofitting means touching every row and query. |
| SQL Basic, **not** serverless | Auto-pause means a 30–60s cold start. An interactive planner that hangs on first load feels broken. Basic never sleeps and costs less. |
| Managed Identity for SQL | No database password exists anywhere. The Odoo service account is the entire secret footprint. |
| No CData in the app | CData is a BI/query gateway — an extra hop and likely per-seat licensing. The API talks to Odoo directly. |

---

## Run it locally

No Azure, no npm install, no database server — `node:sqlite` is built in.

```bash
DEV_USER="you@tqstarling.com" DEV_ROLES="Planner.Editor" node api/src/server.js
# http://localhost:7071
```

`DEV_USER` impersonation is hard-disabled when running in Azure, so a
misconfigured deploy cannot fall open.

### Tests

```bash
node --test api/test/store.test.js
```

Covers the things that actually matter for multi-user: a stale write is **rejected
rather than silently clobbering** a colleague, batch imports are **atomic**, viewers
can't write, TBH deletion doesn't leave orphaned demand, and scenarios stay isolated.

---

## Deploy

You run these under your own `az login`. **No credential ever passes through the
tooling that generated this repo.**

```bash
# 1. resource group
az group create -n rg-tqs-planner -l eastus

# 2. infrastructure  (sqlAdminSid = object id of the Entra group/user that owns SQL)
az deployment group create -g rg-tqs-planner -f infra/main.bicep \
   -p sqlAdminLogin="TQS Planner Admins" sqlAdminSid="<object-id>" \
      odooUrl="https://<your>.odoo.com" odooDb="<db>" odooUser="svc_planner_ro"

# 3. schema
sqlcmd -S <sqlServerFqdn> -d tqsplanner-db -G -i db/schema.sql

# 4. let the site's identity reach the database  (edit <SWA_NAME> first)
sqlcmd -S <sqlServerFqdn> -d tqsplanner-db -G -i scripts/grant-sql.sql

# 5. the one secret
az keyvault secret set --vault-name <keyVaultName> -n odoo-password --value "<password>"
```

### Entra app registration

1. Register an app; add **App Roles**: `Planner.Editor`, `Planner.Viewer`.
2. Redirect URI: `https://<site>/.auth/login/aad/callback`.
3. Put `<TENANT_ID>` into `web/staticwebapp.config.json`.
4. Add `AAD_CLIENT_ID` / `AAD_CLIENT_SECRET` as Static Web App settings.
5. Assign people to roles (Editor for delivery leads; everyone else reads).

Admin consent is required — you'll need to approve it as tenant admin.

---

## Status

- [x] Schema (Azure SQL + SQLite dev mirror)
- [x] API: plan read, allocation/capacity/TBH/import-map writes, optimistic concurrency, audit log
- [x] Entra role enforcement (`Planner.Editor` to write)
- [x] Local dev server + test suite (15 tests, no dependencies)
- [x] Bicep: Static Web App, SQL Basic, Key Vault, App Insights
- [ ] **UI refactor** — port the existing planner from `localStorage` to the API
- [ ] **Odoo read path** — currently mocked; must be verified against a real
      response before it ships. Needs the service account to exist.

The two open items are sequenced that way on purpose: the Odoo integration will be
written against an **observed** request/response, not a guessed one.
