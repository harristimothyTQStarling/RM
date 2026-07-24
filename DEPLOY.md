# Deploy to Railway — runbook

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
git remote add origin https://github.com/<your-username>/tqs-resource-planner.git
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
| Odoo sync fails | expected until the service account exists; doesn't block sign-in or planning |

## Remaining work before this is useful

1. **Port the UI** off `localStorage` to the API (`web/` is a placeholder).
2. **Live Odoo sync** — write + verify against a real response, then populate the
   `ref_*` tables. Needs `ODOO_*` credentials to exist.
