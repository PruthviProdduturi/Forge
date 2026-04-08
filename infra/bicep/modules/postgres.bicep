// =============================================================================
// Forge Data Platform — PostgreSQL Flexible Server Module
//
// Provisions Azure Database for PostgreSQL Flexible Server for Hive Metastore.
// Uses VNet Integration (subnet delegation) — no public network access.
// Uses AAD-only authentication — no password stored anywhere (S360 compliant).
// The HMS managed identity is registered as the AAD admin; HMS pods authenticate
// via workload identity token exchange (azure-identity-extensions JDBC plugin).
//
// S360:
//   - Public network access disabled (network.publicNetworkAccess: Disabled)
//   - VNet Integration provides network isolation (no public IP)
//   - Password authentication disabled — AAD only
//   - TLS enforced (Flex Server default: requireSecureTransport ON)
//   - Backups enabled (7 days dev / 35 days prod)
// =============================================================================

@description('Target environment name (dev or prod).')
@allowed(['dev', 'prod'])
param environment string

@description('Azure region for all resources.')
param location string

@description('PostgreSQL server name (unique across Azure).')
param serverName string

@description('Subnet resource ID for VNet integration — must have Microsoft.DBforPostgreSQL/flexibleServers delegation.')
param subnetId string

@description('Private DNS Zone resource ID for privatelink.postgres.database.azure.com.')
param privateDnsZoneId string

@description('Key Vault resource ID — hms-postgres-host secret is written here after server creation.')
param keyVaultId string

@description('Principal ID (object ID) of the HMS managed identity — registered as the PostgreSQL AAD admin.')
param hmsManagedIdentityPrincipalId string

@description('Display name of the HMS managed identity — used as the PostgreSQL AAD principal name.')
param hmsManagedIdentityName string

@description('Principal ID (object ID) of the Airflow managed identity — registered as a PostgreSQL AAD admin so Airflow pods can authenticate via workload identity token.')
param airflowManagedIdentityPrincipalId string

@description('Display name of the Airflow managed identity.')
param airflowManagedIdentityName string

@description('Object ID of the platform administrator AAD group — allows engineers to run database setup commands via az postgres flexible-server execute with their AAD identity.')
param platformAdminGroupObjectId string

@description('Resource tags to apply to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// SKU and storage — dev uses D2ds_v4, prod uses D4ds_v4
// ---------------------------------------------------------------------------
var sku = environment == 'dev' ? {
  name: 'Standard_D2ds_v4'
  tier: 'GeneralPurpose'
} : {
  name: 'Standard_D4ds_v4'
  tier: 'GeneralPurpose'
}

var storageSizeGB       = environment == 'dev' ? 32  : 64
var backupRetentionDays = environment == 'dev' ? 7   : 35
var geoRedundantBackup  = environment == 'dev' ? 'Disabled' : 'Enabled'

// ---------------------------------------------------------------------------
// PostgreSQL Flexible Server — AAD-only auth, VNet integration
// ---------------------------------------------------------------------------
resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: serverName
  location: location
  tags: tags
  sku: sku
  properties: {
    version: '16'
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: subnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
      publicNetworkAccess: 'Disabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenant().tenantId
    }
  }
}

// ---------------------------------------------------------------------------
// HMS AAD administrator
// HMS managed identity authenticates via JDBC AAD token exchange.
// ---------------------------------------------------------------------------
resource hmsAadAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = {
  parent: postgresServer
  name: hmsManagedIdentityPrincipalId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: hmsManagedIdentityName
    tenantId: tenant().tenantId
  }
}

// ---------------------------------------------------------------------------
// Airflow AAD administrator
// Airflow pods authenticate via workload identity token (no password).
// The connection string uses the managed identity name as the PostgreSQL user
// and an AAD access token (scope: ossrdbms-aad) as the password.
// ---------------------------------------------------------------------------
resource airflowAadAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = {
  parent: postgresServer
  name: airflowManagedIdentityPrincipalId
  dependsOn: [hmsAadAdmin]  // Azure requires serial writes per server
  properties: {
    principalType: 'ServicePrincipal'
    principalName: airflowManagedIdentityName
    tenantId: tenant().tenantId
  }
}

// ---------------------------------------------------------------------------
// Platform admin group — allows engineers to run setup SQL via az CLI AAD auth
// ---------------------------------------------------------------------------
resource platformAdminAadAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = {
  parent: postgresServer
  name: platformAdminGroupObjectId
  dependsOn: [airflowAadAdmin]
  properties: {
    principalType: 'Group'
    principalName: 'forge-platform-admins'
    tenantId: tenant().tenantId
  }
}

// ---------------------------------------------------------------------------
// HMS database
// ---------------------------------------------------------------------------
resource hmsDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgresServer
  name: 'hms_db'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// ---------------------------------------------------------------------------
// Airflow metadata database
// Created at provision time — no password user needed. Airflow pods connect
// via managed identity token (airflowAadAdmin registered above).
// ---------------------------------------------------------------------------
resource airflowDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgresServer
  name: 'airflow'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// ---------------------------------------------------------------------------
// Key Vault secret — HMS server hostname (read by platform engineers at deploy time)
// No password or user secrets — HMS uses AAD token auth
// ---------------------------------------------------------------------------
resource kvRef 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: last(split(keyVaultId, '/'))
}

resource secretHost 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kvRef
  name: 'hms-postgres-host'
  properties: {
    value: postgresServer.properties.fullyQualifiedDomainName
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output serverName string = postgresServer.name
output serverFqdn string = postgresServer.properties.fullyQualifiedDomainName
output databaseName string = hmsDatabase.name
