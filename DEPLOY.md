# Deploy to Azure — step-by-step runbook

Everything here you run yourself under your own `az login`. No credential passes
through anyone else. Copy-paste the blocks in order; each one tells you what to
substitute.

> **Status note.** The **infrastructure, database and API are complete and tested.**
> Two pieces are still in progress and are called out where they matter:
> the **web UI** (`web/` is a stub until the planner is ported off `localStorage`)
> and the **live Odoo read path** (mocked until verified against a real response).
> You can stand up everything below today; the app becomes fully usable once those
> two land.

---

## 0. Prerequisites (one-time)

| Need | How to check / get |
|---|---|
| **Azure CLI** | `az version` — install from https://aka.ms/azcli if missing |
| **Azure subscription** | you own one ✔ |
| **Entra admin rights** | you're almost certainly your own tenant admin ✔ (needed to consent the app) |
| **Odoo read-only service account** | an Odoo user with read access to employees, projects, CRM and timesheets. **No write access needed.** |
| **Bicep** | bundled with recent Azure CLI; `az bicep version` to confirm |

Sign in and pick the subscription:

```bash
az login
az account set --subscription "<your-subscription-name-or-id>"
```

---

## 1. Create the resource group

```bash
az group create -n rg-tqs-planner -l eastus
```

(Swap `eastus` for your preferred region.)

---

## 2. Deploy the infrastructure (Bicep)

This creates: Static Web App, Azure SQL Basic, Key Vault, App Insights, Log Analytics.

First get the object id for the Entra identity that will **own** the SQL server
(simplest: yourself):

```bash
az ad signed-in-user show --query id -o tsv        # this is <sqlAdminSid>
az account show --query user.name -o tsv           # this is your UPN, for editorUpns
```

Then deploy — fill in the five values:

```bash
az deployment group create -g rg-tqs-planner -f infra/main.bicep \
  -p sqlAdminLogin="<your-upn-or-entra-group-name>" \
     sqlAdminSid="<sqlAdminSid-from-above>" \
     editorUpns="<your-upn>" \
     odooUrl="https://<your>.odoo.com" \
     odooDb="<odoo-db-name>" \
     odooUser="<odoo-read-only-username>"
```

When it finishes it prints outputs. **Copy these** — you need them below:

- `siteUrl` — the app's URL
- `sqlServerFqdn` — the SQL server host
- `sqlDatabase` — the database name
- `keyVaultName` — the vault name
- the Static Web App **resource name** (`tqsplanner-web-xxxxx`) — visible in the
  portal or via `az staticwebapp list -g rg-tqs-planner --query "[].name" -o tsv`

There's also a copy of the parameters in `infra/main.parameters.json.example` if
you prefer a parameters file to inline `-p`.

---

## 3. Create the database schema

Connect as yourself (the Entra SQL admin) and run the schema:

```bash
sqlcmd -S <sqlServerFqdn> -d <sqlDatabase> -G -i db/schema.sql
```

`-G` uses your Entra login. If `sqlcmd` prompts for a browser sign-in, that's
expected. (No SQL password exists — the server is Entra-only by design.)

---

## 4. Let the app reach the database

The Static Web App authenticates to SQL with its **managed identity** — no
password. But a database *user* for that identity must be created from inside the
DB (Bicep can't do this). Edit `scripts/grant-sql.sql`, replace `<SWA_NAME>` with
the Static Web App resource name from step 2, then:

```bash
sqlcmd -S <sqlServerFqdn> -d <sqlDatabase> -G -i scripts/grant-sql.sql
```

This grants the site **datareader + datawriter** — it can read and change rows,
but not alter the schema. (Schema changes stay a deliberate, separate act.)

---

## 5. Store the one secret

The only secret in the whole system is the Odoo service-account password:

```bash
az keyvault secret set --vault-name <keyVaultName> -n odoo-password --value "<odoo-password>"
```

(SQL needs no secret — that's the point of managed identity.)

---

## 6. Entra app registration (sign-in)

1. **Register an app** (Entra ID → App registrations → New registration).
   - Redirect URI (Web): `https://<siteUrl>/.auth/login/aad/callback`
2. **Client secret**: Certificates & secrets → New client secret → copy the value.
3. Put your **tenant id** into `web/staticwebapp.config.json` (replace `<TENANT_ID>`).
4. Add these as Static Web App **application settings**
   (Portal → the Static Web App → Configuration, or `az staticwebapp appsettings set`):
   - `AAD_CLIENT_ID` = the app registration's Application (client) ID
   - `AAD_CLIENT_SECRET` = the client secret value
5. **Admin consent**: grant it for the tenant (you, as admin).

Write access is already handled by `editorUpns` from step 2 — **no App Roles to
define and nobody to assign**. To add editors later, append to the `EDITOR_UPNS`
app setting (takes effect immediately, no redeploy).

---

## 7. Deploy the code

The API (`api/`) and the site (`web/`) deploy together to the Static Web App.
Easiest is the SWA CLI:

```bash
npm i -g @azure/static-web-apps-cli
cd api && npm install && cd ..        # pulls @azure/functions + mssql for the API
swa deploy --app-location web --api-location api --env production
```

Or wire the included GitHub Actions workflow (see `.github/` once you push this to
GitHub) so every push deploys automatically — the recommended long-term setup.

---

## 8. Verify

```bash
curl https://<siteUrl>/api/me          # after signing in, shows your UPN + canEdit:true
```

- Sign in at `https://<siteUrl>` — you should be prompted for Microsoft login.
- `/api/me` should report `canEdit: true` for you, `false` for a colleague.
- A colleague can open the link and **see** the plan but not change it.

---

## What you'll have

One link, one shared plan, Entra sign-in, only you can edit, every change
attributed and audited, ~$5–20/month. Odoo stays read-only and untouched.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `sqlcmd … Login failed` | You're not the Entra SQL admin, or not signed in with `-G`. Use the same identity you passed as `sqlAdminLogin`. |
| API returns 500 on DB calls | The managed-identity DB user wasn't created — re-run step 4 with the correct `<SWA_NAME>`. |
| `/api/me` returns 401 after login | Tenant id / client id / secret mismatch in step 6. |
| Odoo reads fail | Expected until the live read path is wired (still mocked). Doesn't block sign-in or plan editing. |
| Self-hosted Odoo unreachable | If Odoo is behind a firewall (not `*.odoo.com`), add the Static Web App's outbound IP to Odoo's allowlist, or use VNet integration. |

## Cost

| Resource | Tier | Approx / month |
|---|---|---|
| Static Web App | Free (Standard ~$9 for SLA) | $0–9 |
| Azure SQL | Basic (5 DTU, 2 GB) | ~$5 |
| Key Vault | Standard | pennies |
| App Insights / Logs | Pay-as-you-go (free tier ample) | ~$0 |
| **Total** | | **~$5–20** |
