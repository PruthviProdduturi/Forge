// =============================================================================
// Forge Data Platform — Shared Infrastructure
// Provisions resources that are shared across all environments:
//   - rg-forge-acr resource group
//   - Azure Container Registry (Premium, private endpoint)
//
// Run this ONCE before any environment deployment.
// The registry is shared by dev and prod (images are promoted across envs
// via tag promotion, not separate registries).
//
// Deploy:
//   az deployment sub create \
//     --location northcentralus \
//     --template-file infra/bicep/environments/shared/main.bicep \
//     --parameters @infra/bicep/environments/shared/shared.parameters.json
// =============================================================================

targetScope = 'subscription'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Primary Azure region for the registry.')
param location string = 'westcentralus'

@description('Owner alias for personal/test deployments (e.g. prproddu). Leave empty for the real shared registry.')
param ownerAlias string = ''

@description('Resource tags applied to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------
var aliasSuffix  = ownerAlias != '' ? '-${ownerAlias}' : ''

// ACR names cannot contain hyphens — embed alias directly.
// When alias is blank, append first 8 chars of subscription ID for global uniqueness.
var subSuffix    = substring(replace(subscription().subscriptionId, '-', ''), 0, 8)
var registryName = ownerAlias != '' ? 'forgeacr${ownerAlias}' : 'forgeacr${subSuffix}'
var rgName       = 'rg-forge-acr${aliasSuffix}'

var mergedTags = union(tags, {
  platform: 'forge'
  managedBy: 'bicep'
  shared: 'true'
})

// ---------------------------------------------------------------------------
// Resource Group
// ---------------------------------------------------------------------------
resource rgAcr 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: rgName
  location: location
  tags: mergedTags
}

// ---------------------------------------------------------------------------
// ACR Module
// ---------------------------------------------------------------------------
module acr '../../modules/acr.bicep' = {
  name: 'acr-shared'
  scope: resourceGroup(rgName)
  dependsOn: [rgAcr]
  params: {
    registryName: registryName
    location: location
    tags: mergedTags
    publicNetworkAccessEnabled: ownerAlias != ''  // dev personal deployments: allow public access; shared/prod: disabled
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output registryId string = acr.outputs.registryId
output registryName string = acr.outputs.registryName
output loginServer string = acr.outputs.loginServer
