// =============================================================================
// Forge Data Platform — Key Vault Module
// Provisions a Premium Key Vault with RBAC authorization, private endpoint,
// soft-delete, purge protection, and diagnostic settings.
// =============================================================================

@description('Key Vault name (3-24 alphanumeric and hyphen characters).')
@minLength(3)
@maxLength(24)
param keyVaultName string

@description('Azure region for all resources.')
param location string

@description('Azure AD tenant ID.')
param tenantId string

@description('Resource ID of the subnet for the private endpoint.')
param privateEndpointSubnetId string

@description('Resource ID of the Private DNS Zone for Key Vault.')
param privateDnsZoneVaultId string

@description('Object ID of the platform administrator AAD group.')
param platformAdminGroupObjectId string

@description('Principal IDs for each workload that needs secrets access.')
param workloadPrincipalIds object

@description('Resource ID of the Log Analytics Workspace for diagnostics.')
param logAnalyticsWorkspaceId string

@description('Allow public network access to Key Vault. RBAC enforces access control. Both dev and prod use public access + RBAC; private endpoint still preferred for service-to-service traffic.')
param allowPublicNetworkAccess bool = true

@description('Resource tags to apply to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Role definition resource IDs (built-in)
// ---------------------------------------------------------------------------
var kvSecretsOfficerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
var kvCryptoOfficerRoleId  = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '14b46e9e-c2b7-41b4-b07b-48a6ebf60603')
var kvSecretsUserRoleId    = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

// ---------------------------------------------------------------------------
// Key Vault
// ---------------------------------------------------------------------------
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'premium'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    // Public access enabled; RBAC enforces who can read/write secrets.
    // Private endpoint still used for service-to-service traffic (pods, Bicep).
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkAcls: {
      defaultAction: allowPublicNetworkAccess ? 'Allow' : 'Deny'
      bypass: 'AzureServices'
      ipRules: []
      virtualNetworkRules: []
    }
    enabledForDeployment: false
    enabledForDiskEncryption: false
    enabledForTemplateDeployment: false
  }
}

// ---------------------------------------------------------------------------
// Platform admin — Secrets Officer
// ---------------------------------------------------------------------------
resource adminSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(platformAdminGroupObjectId, kvSecretsOfficerRoleId, keyVault.id)
  scope: keyVault
  properties: {
    roleDefinitionId: kvSecretsOfficerRoleId
    principalId: platformAdminGroupObjectId
    principalType: 'Group'
    description: 'Platform admin group — Key Vault Secrets Officer'
  }
}

// ---------------------------------------------------------------------------
// Platform admin — Crypto Officer
// ---------------------------------------------------------------------------
resource adminCryptoOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(platformAdminGroupObjectId, kvCryptoOfficerRoleId, keyVault.id)
  scope: keyVault
  properties: {
    roleDefinitionId: kvCryptoOfficerRoleId
    principalId: platformAdminGroupObjectId
    principalType: 'Group'
    description: 'Platform admin group — Key Vault Crypto Officer'
  }
}

// ---------------------------------------------------------------------------
// Workload role assignments — Key Vault Secrets User
// ---------------------------------------------------------------------------
resource sparkSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workloadPrincipalIds.spark, kvSecretsUserRoleId, keyVault.id)
  scope: keyVault
  properties: {
    roleDefinitionId: kvSecretsUserRoleId
    principalId: workloadPrincipalIds.spark
    principalType: 'ServicePrincipal'
    description: 'Spark workload identity — Key Vault Secrets User'
  }
}

resource trinoSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workloadPrincipalIds.trino, kvSecretsUserRoleId, keyVault.id)
  scope: keyVault
  properties: {
    roleDefinitionId: kvSecretsUserRoleId
    principalId: workloadPrincipalIds.trino
    principalType: 'ServicePrincipal'
    description: 'Trino workload identity — Key Vault Secrets User'
  }
}

resource airflowSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workloadPrincipalIds.airflow, kvSecretsUserRoleId, keyVault.id)
  scope: keyVault
  properties: {
    roleDefinitionId: kvSecretsUserRoleId
    principalId: workloadPrincipalIds.airflow
    principalType: 'ServicePrincipal'
    description: 'Airflow workload identity — Key Vault Secrets User'
  }
}

resource dqSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workloadPrincipalIds.dq, kvSecretsUserRoleId, keyVault.id)
  scope: keyVault
  properties: {
    roleDefinitionId: kvSecretsUserRoleId
    principalId: workloadPrincipalIds.dq
    principalType: 'ServicePrincipal'
    description: 'DQ workload identity — Key Vault Secrets User'
  }
}

// Portal needs Secrets Officer so it can write auth-config secrets from the Settings UI.
resource portalSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workloadPrincipalIds.portal, kvSecretsOfficerRoleId, keyVault.id)
  scope: keyVault
  properties: {
    roleDefinitionId: kvSecretsOfficerRoleId
    principalId: workloadPrincipalIds.portal
    principalType: 'ServicePrincipal'
    description: 'Portal workload identity — Key Vault Secrets Officer (auth-config read/write)'
  }
}


// ---------------------------------------------------------------------------
// Private Endpoint
// ---------------------------------------------------------------------------
resource pepKeyVault 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pep-${keyVaultName}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'plsc-${keyVaultName}'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: ['vault']
          requestMessage: 'Auto-approved private endpoint for Key Vault'
        }
      }
    ]
    customNetworkInterfaceName: 'nic-pep-${keyVaultName}'
  }
}

resource pepKeyVaultDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: pepKeyVault
  name: 'dnsZoneGroup'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-vaultcore-azure-net'
        properties: {
          privateDnsZoneId: privateDnsZoneVaultId
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Diagnostic Settings
// ---------------------------------------------------------------------------
resource kvDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-${keyVaultName}'
  scope: keyVault
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'AuditEvent'
        enabled: true
      }
      {
        category: 'AzurePolicyEvaluationDetails'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output privateEndpointId string = pepKeyVault.id
