// =============================================================================
// Forge Data Platform — Azure Container Registry Module
// Premium SKU with private endpoint, Defender for Containers, and content trust.
// This is a shared registry (no env suffix on the registry itself) but the
// private endpoint and DNS zone link are scoped to a specific VNet.
// =============================================================================

@description('Name of the container registry (e.g. forgeacr).')
param registryName string

@description('Azure region for the registry.')
param location string

@description('Subnet resource ID for the private endpoint NIC. Leave empty to skip PE creation (shared deployment phase).')
param privateEndpointSubnetId string = ''

@description('Resource ID of the privatelink.azurecr.io private DNS zone. Leave empty to skip PE creation.')
param privateDnsZoneAcrId string = ''

@description('Resource ID of a Log Analytics Workspace for ACR audit diagnostics. Leave empty to skip (shared deployment has no LAW yet).')
param logAnalyticsWorkspaceId string = ''

@description('Set to true during initial shared deployment (before private endpoint exists). Set to false after PE is in place to prevent data exfiltration.')
param exportPolicyEnabled bool = true

@description('Resource tags to apply to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Container Registry — Premium SKU required for private endpoints,
// geo-replication, content trust, and retention policies.
// ---------------------------------------------------------------------------
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Premium'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Disabled'
    networkRuleBypassOptions: 'AzureServices'
    zoneRedundancy: 'Disabled'
    policies: {
      quarantinePolicy: {
        status: 'enabled'
      }
      trustPolicy: {
        type: 'Notary'
        status: 'enabled'
      }
      retentionPolicy: {
        days: 30
        status: 'enabled'
      }
      exportPolicy: {
        // S360: Set to 'disabled' after private endpoint is in place.
        // Must remain 'enabled' during initial bootstrap (ACR Tasks need it).
        status: exportPolicyEnabled ? 'enabled' : 'disabled'
      }
    }
    encryption: {
      status: 'disabled'
    }
  }
}

// ---------------------------------------------------------------------------
// Private Endpoint — ACR data plane over private IP
// Only created when subnetId is provided (env deployments, not shared).
// ---------------------------------------------------------------------------
resource acrPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (privateEndpointSubnetId != '') {
  name: 'pe-${registryName}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'plsc-${registryName}'
        properties: {
          privateLinkServiceId: acr.id
          groupIds: ['registry']
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Private DNS Zone Group — auto-registers PE NIC IP into the DNS zone
// ---------------------------------------------------------------------------
resource acrDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (privateEndpointSubnetId != '') {
  parent: acrPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-azurecr-io'
        properties: {
          privateDnsZoneId: privateDnsZoneAcrId
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Diagnostic Settings — ACR audit logs (skipped for shared deployment)
// ---------------------------------------------------------------------------
resource acrDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (logAnalyticsWorkspaceId != '') {
  name: 'diag-${registryName}'
  scope: acr
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'ContainerRegistryRepositoryEvents'
        enabled: true
      }
      {
        category: 'ContainerRegistryLoginEvents'
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
output registryId string = acr.id
output registryName string = acr.name
output loginServer string = acr.properties.loginServer
