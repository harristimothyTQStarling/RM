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
| `EDITOR_UPNS` allowlist alongside App Roles | With a single editor, App Roles mean defining roles and assigning users in Entra for no benefit. An allowlist is one app setting. The role path still works, so growing to several editors needs no code change. |

## Who can do what

**One editor; everyone else in the tenant is read-only.**

Write access is granted by *either*:

- **`EDITOR_UPNS`** app setting — `tim@tqstarling.com`. Changing it takes effect
  immediately, no redeploy. This is the simple path while it's just you.
- **`Planner.Editor`** App Role — the path once several people edit.

Anyone signed in can read. Nobody signed out can do anything. An empty allowlist
denies rather than falling open, and `DEV_USER` impersonation is inert in Azure —
both are covered by tests, because "accidentally world-writable" is the one bug
that must never ship.

Concurrency control is kept even with a single editor: you *will* eventually have
the planner open in two tabs, and it costs nothing.

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
cd api && npm test          # or: node --test "api/test/*.test.js"
```

(Pass the glob, not the directory — `node --test api/test/` misreads it as a
module path and reports a spurious failure.)

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
      editorUpns="tim@tqstarling.com" \
      odooUrl="https://<your>.odoo.com" odooDb="<db>" odooUser="svc_planner_ro"

# 3. schema
sqlcmd -S <sqlServerFqdn> -d tqsplanner-db -G -i db/schema.sql

# 4. let the site's identity reach the database  (edit <SWA_NAME> first)
sqlcmd -S <sqlServerFqdn> -d tqsplanner-db -G -i scripts/grant-sql.sql

# 5. the one secret
az keyvault secret set --vault-name <keyVaultName> -n odoo-password --value "<password>"
```

### Entra app registration

1. Register an app. Redirect URI: `https://<site>/.auth/login/aad/callback`.
2. Put `<TENANT_ID>` into `web/staticwebapp.config.json`.
3. Add `AAD_CLIENT_ID` / `AAD_CLIENT_SECRET` as Static Web App settings.

That's it while you're the only editor — `EDITOR_UPNS` handles write access, so
there are **no App Roles to define and nobody to assign**. Admin consent is still
required for sign-in; you approve it as tenant admin.

**Later, to add editors:** either append to `EDITOR_UPNS` (instant, no redeploy),
or add a `Planner.Editor` App Role and assign people to it — the API already
honours both.

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
