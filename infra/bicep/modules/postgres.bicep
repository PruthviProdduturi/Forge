// =============================================================================
// Forge Data Platform — PostgreSQL Flexible Server Module
//
// Provisions Azure Database for PostgreSQL Flexible Server for Hive Metastore.
// Uses VNet Integration (subnet delegation) — no public network access.
// Stores connection secrets in Key Vault for HMS helm chart consumption.
//
// S360:
//   - Public network access disabled (network.publicNetworkAccess: Disabled)
//   - VNet Integration provides network isolation (no public IP)
//   - TLS enforced (requireSecureTransport: ON is the default for Flex Server)
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

@description('Key Vault resource ID — HMS connection secrets are written here after server creation.')
param keyVaultId string

@description('HMS PostgreSQL admin username.')
param adminUsername string = 'hmsadmin'

@secure()
@description('HMS PostgreSQL admin password. Pass on CLI — do not store in parameters file.')
param adminPassword string

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

var storageSizeGB         = environment == 'dev' ? 32  : 64
var backupRetentionDays   = environment == 'dev' ? 7   : 35
var geoRedundantBackup    = environment == 'dev' ? 'Disabled' : 'Enabled'

// ---------------------------------------------------------------------------
// PostgreSQL Flexible Server
// ---------------------------------------------------------------------------
resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: serverName
  location: location
  tags: tags
  sku: sku
  properties: {
    administratorLogin: adminUsername
    administratorLoginPassword: adminPassword
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
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
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
// Key Vault secrets — consumed by HMS helm chart via az keyvault secret show
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

resource secretUser 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kvRef
  name: 'hms-postgres-user'
  properties: {
    value: adminUsername
  }
}

resource secretPassword 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kvRef
  name: 'hms-postgres-password'
  properties: {
    value: adminPassword
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output serverName string = postgresServer.name
output serverFqdn string = postgresServer.properties.fullyQualifiedDomainName
output databaseName string = hmsDatabase.name
