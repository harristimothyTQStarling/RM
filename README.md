# TQStarling Resource Planner

Shared, multi-user resource planning for calendar-year staffing: allocate hours per
person per project per month, and see utilization by employee, role and customer.

Replaces the single-user browser tool — one link, one plan, real persistence.

**Deploying:** see [DEPLOY.md](DEPLOY.md) (Railway + Postgres + Entra sign-in).

---

## Architecture

```
  Browser
     |   Microsoft Entra sign-in (OIDC, implemented in-app)
     v
  Railway service  -- one process, api/src/server.js
     |
     |-- /auth/*   Entra OpenID Connect  ->  signed session cookie
     |-- /api/*    JSON API   handlers.js -> store.js -> db.js
     |-- /*        static UI from web/
     |
     +--> Railway Postgres    the PLAN (read/write) + Odoo reference cache
     +--> Odoo (read-only)    people | projects | CRM | actuals
```

**Odoo stays the system of record** for people, projects, CRM pipeline and timesheet
actuals, and is **read-only** — this app cannot corrupt the ERP, and only a read-only
service account is needed (far easier to get approved than write access). Its data is
cached in the `ref_*` tables so a page load never blocks on Odoo, and the app keeps
working if Odoo is briefly unreachable.

**Postgres stores the forward plan** — roughly 2–4k rows a year.

## Deliberate decisions

| Decision | Why |
|---|---|
| `resource_key` / `target_key` composite text keys | A resource is an employee **or** a to-be-hired seat; a target is a project **or** a CRM opportunity. Nullable FK columns would need CHECK gymnastics and break natural-key uniqueness. |
| Explicit `version INT`, not `xmin`/`rowversion` | Same optimistic-concurrency semantics but portable — identical logic runs on SQLite locally, so concurrency is testable with **no database server**. |
| `scenario` column from day one | Enables what-if planning ("what if we win Medtronic?"). Free now; retrofitting means touching every row and query. |
| `jose` for token validation, hand-rolled redirect | The redirect/token-exchange is plain, well-specified HTTP. Signature/issuer/audience/expiry validation is where auth bugs ship, so that goes to an audited library. |
| Edit rights via `EDITOR_UPNS`, not Entra App Roles | Adding an editor is an env-var change (instant, no redeploy, no Entra admin work), and we don't depend on role assignment being configured correctly. |
| Postgres type parsers pinned | node-postgres returns `NUMERIC` as a **string** (hour arithmetic would concatenate) and `DATE` as a local-time `Date` (months could shift). Both are overridden in `db.js`. |
| Odoo cached in `ref_*` tables | A page load never blocks on Odoo, and an Odoo outage doesn't take the planner down. |

## Access model

| | |
|---|---|
| **Sign in** | anyone in your Entra tenant (the `tid` claim is verified — no outside accounts) |
| **Edit** | only addresses in `EDITOR_UPNS` |
| **Everyone else** | read-only |
| **Add/remove an editor** | edit the variable — immediate, no redeploy |
| **Revoke all sessions** | rotate `SESSION_SECRET` |

Sessions are a signed, HttpOnly, Secure, SameSite=Lax cookie lasting 10 hours. We
request only `openid profile email` and never store Microsoft tokens.

---

## Run it locally

No Postgres, no Azure, no npm install needed for the database — `node:sqlite` is
built into Node 20+.

```bash
cd api && npm install
DEV_USER="you@tqstarling.com" EDITOR_UPNS="you@tqstarling.com" npm run dev
# http://localhost:7071
```

`DEV_USER` impersonation is **hard-disabled** when `NODE_ENV=production` or when the
`AAD_*` variables are set, so a misconfigured deploy can never accept a forged
identity. (There's a test for exactly that.)

### Tests

```bash
cd api && npm test        # 27 tests, no external services
```

They cover what actually matters for a shared plan: a stale write is **rejected
rather than silently clobbering** a colleague; batch imports are **atomic**; viewers
can't write; the allowlist **denies when empty** rather than falling open; tampered,
wrongly-signed and expired session cookies are all rejected; TBH deletion leaves no
orphaned demand; scenarios stay isolated.

## Layout

```
api/src/server.js    one process: auth routes, API, static UI
api/src/oidc.js      Entra OIDC (PKCE, state/nonce, tenant lock, session cookie)
api/src/auth.js      identity from the cookie + EDITOR_UPNS edit rights
api/src/handlers.js  routing; framework-free (method, path, body) -> {status, body}
api/src/store.js     the plan + optimistic concurrency + audit log
api/src/db.js        sqlite (dev/test) | postgres (prod), one interface
api/src/migrate.js   applies db/schema.postgres.sql on boot, idempotent
db/                  schema.postgres.sql + schema.sqlite.sql (kept in step)
web/                 static UI  ** placeholder — port pending **
Dockerfile           what Railway builds
```

## Status

- [x] Postgres schema + driver, SQLite mirror for local/tests
- [x] API: plan read, allocation/capacity/TBH/import-map writes, optimistic concurrency, audit log
- [x] Microsoft Entra sign-in (OIDC + PKCE), signed sessions, tenant lock
- [x] Named-editor allowlist; everyone else read-only
- [x] Railway container, boot migrations, healthcheck
- [x] 27 tests, no external services required
- [ ] **UI port** — move the planner off `localStorage` onto the API
- [ ] **Live Odoo sync** — populate `ref_*`; to be written and **verified against a
      real response**, not guessed. Needs the read-only service account.
