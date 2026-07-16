/* =============================================================================
   TQStarling Resource Planner — Azure infrastructure
   =============================================================================
   Deploy:
     az group create -n rg-tqs-planner -l eastus
     az deployment group create -g rg-tqs-planner -f infra/main.bicep \
        -p sqlAdminLogin=<your-entra-group-or-upn> sqlAdminSid=<object-id>

   Deliberately small: a static site + managed Functions, a Basic SQL database,
   Key Vault for the one secret we cannot avoid (the Odoo service account), and
   App Insights. No VM, no container, no separate app-service plan.

   Odoo remains the system of record for people/projects/CRM/actuals and is read
   ONLY — so this stack can never corrupt the ERP.
   ============================================================================= */

@description('Base name; resources are suffixed with a uniqueness hash.')
param name string = 'tqsplanner'

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Entra login (group name or UPN) that will own the SQL server.')
param sqlAdminLogin string

@description('Object id of that Entra user/group.')
param sqlAdminSid string

@description('Odoo base URL, e.g. https://tqstarling.odoo.com — read-only access.')
param odooUrl string = ''

@description('Odoo database name.')
param odooDb string = ''

@description('Odoo service-account username (read-only).')
param odooUser string = ''

var suffix = uniqueString(resourceGroup().id)
var sqlServerName = '${name}-sql-${suffix}'
var dbName = '${name}-db'
var kvName = take('${name}kv${suffix}', 24)

/* ----------------------------------------------------------- observability -- */
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs-${suffix}'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${name}-ai-${suffix}'
  location: location
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id }
}

/* -------------------------------------------------------------------- sql -- */
/* Entra-only auth: no SQL logins, no passwords, nothing to leak or rotate. */
resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: sqlServerName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    administrators: {
      administratorType: 'ActiveDirectory'
      login: sqlAdminLogin
      sid: sqlAdminSid
      tenantId: subscription().tenantId
      azureADOnlyAuthentication: true
      principalType: 'Group'
    }
  }
}

/* Basic tier: ~2-4k rows/year lives here comfortably. Explicitly NOT serverless —
   auto-pause cold starts (~30-60s) make an interactive planner feel broken. */
resource sqlDb 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: dbName
  location: location
  sku: { name: 'Basic', tier: 'Basic', capacity: 5 }
  properties: { maxSizeBytes: 2147483648, zoneRedundant: false }
}

resource allowAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: sqlServer
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

/* --------------------------------------------------------------- key vault -- */
/* Holds only the Odoo service-account password. SQL needs no secret at all
   (Managed Identity), so this is the entire secret footprint. */
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

/* --------------------------------------------------------- static web app -- */
/* Free tier is adequate for an internal tool; Standard adds an SLA + custom auth. */
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${name}-web-${suffix}'
  location: location
  sku: { name: 'Free', tier: 'Free' }
  identity: { type: 'SystemAssigned' }
  properties: {
    buildProperties: { appLocation: 'web', apiLocation: 'api', outputLocation: 'web' }
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
  }
}

resource swaSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    DB_DRIVER: 'mssql'
    DB_SERVER: '${sqlServerName}${environment().suffixes.sqlServerHostname}'
    DB_NAME: dbName
    ODOO_URL: odooUrl
    ODOO_DB: odooDb
    ODOO_USER: odooUser
    ODOO_PASSWORD_REF: '@Microsoft.KeyVault(VaultName=${kvName};SecretName=odoo-password)'
    KEY_VAULT_NAME: kvName
    APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties.ConnectionString
    NODE_ENV: 'production'
  }
}

/* Let the site read its one secret. SQL access is granted separately by running
   scripts/grant-sql.sql — Bicep cannot create a database user. */
var kvSecretsUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
resource kvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, swa.id, kvSecretsUser)
  properties: {
    roleDefinitionId: kvSecretsUser
    principalId: swa.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output siteUrl string = 'https://${swa.properties.defaultHostname}'
output sqlServerFqdn string = '${sqlServerName}${environment().suffixes.sqlServerHostname}'
output sqlDatabase string = dbName
output keyVaultName string = kvName
output webAppPrincipalId string = swa.identity.principalId
output nextSteps string = 'Run scripts/grant-sql.sql against the DB (grants the site''s identity), then az keyvault secret set --vault-name ${kvName} -n odoo-password --value <odoo service account password>'
