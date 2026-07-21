<#
  Guided Azure deploy for the TQStarling Resource Planner.
  Runs infra steps 1, 2 and 5 from DEPLOY.md, then prints the manual follow-ups
  (schema, grant-sql, Entra app registration, code deploy) that can't be safely
  scripted without more of your input.

  You run this under your own `az login`. No secret is stored in the repo.

  Example:
    az login
    ./scripts/deploy.ps1 `
        -EditorUpn  "tim@tqstarling.com" `
        -OdooUrl    "https://tqstarling.odoo.com" `
        -OdooDb     "tqstarling" `
        -OdooUser   "svc_planner_ro" `
        -OdooPassword (Read-Host "Odoo password" -AsSecureString)
#>
[CmdletBinding()]
param(
  [string]$ResourceGroup = "rg-tqs-planner",
  [string]$Location      = "eastus",
  [Parameter(Mandatory)] [string]$EditorUpn,
  [Parameter(Mandatory)] [string]$OdooUrl,
  [Parameter(Mandatory)] [string]$OdooDb,
  [Parameter(Mandatory)] [string]$OdooUser,
  [Parameter(Mandatory)] [securestring]$OdooPassword
)

$ErrorActionPreference = "Stop"
function Step($n, $m) { Write-Host "`n=== $n. $m ===" -ForegroundColor Cyan }

# whoami — object id owns SQL, UPN is the fallback admin login
$sid = az ad signed-in-user show --query id -o tsv
$upn = az account show --query user.name -o tsv
if (-not $sid) { throw "Not signed in. Run 'az login' first." }
Write-Host "Signed in as $upn ($sid)" -ForegroundColor Green

Step 1 "Resource group"
az group create -n $ResourceGroup -l $Location -o none
Write-Host "  $ResourceGroup ready in $Location"

Step 2 "Infrastructure (Bicep)"
$deploy = az deployment group create -g $ResourceGroup -f infra/main.bicep `
  -p sqlAdminLogin=$upn sqlAdminSid=$sid editorUpns=$EditorUpn `
     odooUrl=$OdooUrl odooDb=$OdooDb odooUser=$OdooUser `
  --query properties.outputs -o json | ConvertFrom-Json

$site   = $deploy.siteUrl.value
$sqlFqdn= $deploy.sqlServerFqdn.value
$sqlDb  = $deploy.sqlDatabase.value
$kv     = $deploy.keyVaultName.value
$swaName= (az staticwebapp list -g $ResourceGroup --query "[0].name" -o tsv)

Write-Host "  siteUrl        : $site"
Write-Host "  sqlServerFqdn  : $sqlFqdn"
Write-Host "  sqlDatabase    : $sqlDb"
Write-Host "  keyVaultName   : $kv"
Write-Host "  staticWebApp   : $swaName"

Step 5 "Store Odoo password in Key Vault"
$plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($OdooPassword))
az keyvault secret set --vault-name $kv -n odoo-password --value $plain -o none
$plain = $null
Write-Host "  odoo-password stored"

Write-Host "`n--- NOW DO THESE MANUALLY (see DEPLOY.md) ---" -ForegroundColor Yellow
Write-Host "3. Schema:      sqlcmd -S $sqlFqdn -d $sqlDb -G -i db/schema.sql"
Write-Host "4. Grant DB:    edit scripts/grant-sql.sql -> <SWA_NAME> = $swaName, then"
Write-Host "                sqlcmd -S $sqlFqdn -d $sqlDb -G -i scripts/grant-sql.sql"
Write-Host "6. Entra app:   register app, set redirect https://$site/.auth/login/aad/callback,"
Write-Host "                put tenant id in web/staticwebapp.config.json,"
Write-Host "                add AAD_CLIENT_ID / AAD_CLIENT_SECRET as SWA app settings, grant admin consent"
Write-Host "7. Deploy code: swa deploy --app-location web --api-location api --env production"
Write-Host "8. Verify:      open https://$site  and  curl https://$site/api/me"
