# Deploy to Railway — runbook

## THIS DEPLOYMENT (created 2026-07-24)

The Railway project, Postgres and service are already created and configured.
What's left is on you (GitHub push + Entra + two secrets) — see the checklist.

| | |
|---|---|
| **App URL** | https://planner-production-1a7b.up.railway.app |
| **Entra redirect URI** | `https://planner-production-1a7b.up.railway.app/auth/callback` |
| Railway project | `tqs-resource-planner` (`c327e565-e2c3-46d3-b743-abc2523f96ec`) |
| `planner` service | `813eeb8d-1d69-4307-a5b7-dbfc646ab2c5` |
| Postgres service | `d70c9a7e-6aea-45de-a1b4-62e6341ce245` |
| Vars already set | `DB_DRIVER, DATABASE_URL, EDITOR_UPNS, ODOO_URL, ODOO_DB, ODOO_USER, PUBLIC_URL, SESSION_SECRET` |
| **You still set** | `AAD_TENANT_ID, AAD_CLIENT_ID, AAD_CLIENT_SECRET, ODOO_PASSWORD` |

### Remaining checklist

1. **Create the private GitHub repo and push.** On github.com create a **Private**
   repo named `RM` under `harristimothyTQStarling`, then:
   ```bash
   cd C:\Users\timha\tqs-resource-planner
   git push -u origin main
   ```
2. **Give Railway access to the repo.** In Railway → the `planner` service →
   Settings → Source, connect GitHub and select `harristimothyTQStarling/RM`.
   This triggers the first build from the Dockerfile.
3. **Register the Entra app** (Entra ID → App registrations → New):
   - Redirect URI (Web): `https://planner-production-1a7b.up.railway.app/auth/callback`
   - Create a client secret; note the client id and tenant id; grant admin consent.
4. **Set the four secret variables** on the `planner` service in Railway:
   `AAD_TENANT_ID`, `AAD_CLIENT_ID`, `AAD_CLIENT_SECRET`, `ODOO_PASSWORD`
   (the read-only `svc_planner_ro` password).
5. **Done.** On deploy the schema is applied and — because Odoo is now
   configured — the reference data syncs from Odoo automatically on first boot.
   Open the URL, sign in with Microsoft, and you're in.

Detailed reference for each step follows.

---



You run these steps under your own accounts. **No credential passes through the
tooling that generated this repo.** There's a chicken-and-egg with the Entra
redirect URI (you need the Railway URL first), so the order below matters.

> **Status.** Backend, auth and database are done and tested. Still outstanding
> before this is worth deploying: the **web UI port** (`web/` is a placeholder)
> and the **live Odoo sync** (needs the read-only service account). See
> *Remaining work* at the bottom.

---

## 0. Prerequisites

| Need | Notes |
|---|---|
| **GitHub account** | repo must be **private** — it will hold staff names and rates |
| **Railway account** | https://railway.app — Postgres + service is roughly $5–10/mo |
| **Entra tenant admin** | to register the app and grant consent (you) |
| **Odoo read-only service account** | for the sync; the app never writes to Odoo |

---

## 1. Push to GitHub

```bash
cd C:\Users\timha\tqs-resource-planner
git remote add origin https://github.com/harristimothyTQStarling/RM.git
git branch -M main
git push -u origin main
```

Create the repo on github.com first as **Private**.

---

## 2. Create the Railway project

1. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
2. Railway detects the `Dockerfile` and builds it.
3. **Add Postgres**: in the project, **New → Database → Postgres**. Railway sets
   `DATABASE_URL` on the service automatically.
4. **Generate a domain**: service → Settings → Networking → **Generate Domain**.
   Copy it — e.g. `https://tqs-resource-planner-production.up.railway.app`.
   That URL is your `PUBLIC_URL`.

The schema is applied automatically on every boot (`api/src/migrate.js`, all
`CREATE ... IF NOT EXISTS`) — there is no separate migration step to forget.

---

## 3. Register the Entra app

Entra ID → **App registrations → New registration**:

- **Redirect URI** (type *Web*): `<PUBLIC_URL>/auth/callback`
  — e.g. `https://tqs-...up.railway.app/auth/callback`. Must match exactly.
- **Certificates & secrets → New client secret** → copy the *value*.
- Note the **Application (client) ID** and **Directory (tenant) ID**.
- Grant **admin consent** (you're the admin). Scopes are just `openid profile
  email` — no Graph access, nothing else is requested.

No App Roles to define and nobody to assign — edit rights are the `EDITOR_UPNS`
allowlist below.

---

## 4. Set Railway service variables

Service → **Variables**:

```
DB_DRIVER=postgres
AAD_TENANT_ID=<directory (tenant) id>
AAD_CLIENT_ID=<application (client) id>
AAD_CLIENT_SECRET=<the secret VALUE>
PUBLIC_URL=https://<your-domain>          # no trailing slash
SESSION_SECRET=<openssl rand -base64 48>
EDITOR_UPNS=tim@tqstarling.com,someone@tqstarling.com
IMPORTER_UPNS=tim@tqstarling.com            # optional; who may IMPORT a forecast. Unset => tim only. Empty => nobody.
ODOO_URL=https://<your>.odoo.com
ODOO_DB=<odoo database name>
ODOO_USER=<read-only service account>
ODOO_PASSWORD=<its password>
```

`DATABASE_URL` and `PORT` are injected by Railway — don't set them.

Redeploy after saving.

---

## 5. Verify

```bash
curl https://<your-domain>/healthz          # {"ok":true,"db":"postgres"}
```

- Open `https://<your-domain>` → you should be bounced to Microsoft sign-in.
- After signing in you land on the planner.
- `/api/me` → `{"upn":"...","canEdit":true}` for an address in `EDITOR_UPNS`,
  `canEdit:false` for anyone else.
- A colleague can sign in and **view** but not change anything.

---

## Access model

| | |
|---|---|
| **Sign in** | anyone in your Entra tenant (the `tid` claim is checked, so no outside accounts) |
| **Edit** | only addresses listed in `EDITOR_UPNS` |
| **Import a forecast** | only addresses in `IMPORTER_UPNS` (unset ⇒ `tim@tqstarling.com`; must also be an editor) — an import rewrites the whole plan, so it is held tighter than editing |
| **Everyone else** | read-only |
| **Changing editors** | edit the variable — takes effect immediately, no redeploy |
| **Revoking all sessions** | rotate `SESSION_SECRET` — every cookie becomes invalid |

Sessions are a signed, HttpOnly, Secure, SameSite=Lax cookie lasting 10 hours.
We never store Microsoft tokens.

## Cost

| | |
|---|---|
| Service (container) | ~$5/mo at low usage |
| Postgres | ~$5/mo |
| **Total** | **~$10/mo** |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `AADSTS50011` redirect mismatch | `PUBLIC_URL` must exactly equal the registered redirect URI minus `/auth/callback`; no trailing slash |
| Redirect loop | `SESSION_SECRET` unset or changing between instances — set it explicitly |
| `sign-in is not configured` | one of `AAD_*` / `PUBLIC_URL` / `SESSION_SECRET` is missing |
| Everyone read-only | `EDITOR_UPNS` empty or a typo'd address (it denies rather than falling open, by design) |
| `DATABASE_URL is required` | Postgres plugin not attached to the service |
| Odoo sync fails | check `ODOO_PASSWORD`; the boot log prints the sync result. Doesn't block sign-in or planning — the app just has no reference data until a sync succeeds. |
| `planner` service offline | expected until the GitHub repo is pushed and connected (checklist steps 1–2) |

The UI, the API, the Entra sign-in and the live Odoo sync are all built and
tested — the checklist at the top is genuinely all that remains.
