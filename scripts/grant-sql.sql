/* Grant the Static Web App's managed identity access to the database.
   Bicep cannot do this — a database user must be created from inside the DB.

   Run ONCE after `az deployment group create`, connected to the planner database
   as the Entra SQL admin (the group/user you passed as sqlAdminLogin):

     sqlcmd -S <sqlServerFqdn> -d <sqlDatabase> -G -i scripts/grant-sql.sql

   Replace <SWA_NAME> with the Static Web App's resource name — its managed
   identity carries the same name. (`az deployment group show` prints it, or read
   the webAppPrincipalId output.)

   Note the site gets datareader/datawriter only — it can read and change rows,
   but cannot alter the schema. Migrations stay a deliberate, separate act. */

DECLARE @identity SYSNAME = N'<SWA_NAME>';

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @identity)
BEGIN
    DECLARE @sql NVARCHAR(MAX) = N'CREATE USER ' + QUOTENAME(@identity) + N' FROM EXTERNAL PROVIDER;';
    EXEC sp_executesql @sql;
END

DECLARE @g NVARCHAR(MAX) =
    N'ALTER ROLE db_datareader ADD MEMBER ' + QUOTENAME(@identity) + N';' +
    N'ALTER ROLE db_datawriter ADD MEMBER ' + QUOTENAME(@identity) + N';';
EXEC sp_executesql @g;

SELECT name, type_desc FROM sys.database_principals WHERE name = @identity;
