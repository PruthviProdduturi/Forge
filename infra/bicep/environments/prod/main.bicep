// =============================================================================
// Forge Data Platform — Prod Environment Root Template
// Subscription-scoped orchestration template that provisions resource groups
// and calls all platform modules in dependency order.
//
// Deployment order:
//   1. Resource Groups (parallel)
//   2. Networking
//   3. AKS clusters (compute + orchestration, parallel, both depend on networking)
//   4. Storage (depends on networking + orchCluster LAW)
//   5. Identity (depends on both AKS clusters + storage)
//   6. Key Vault (depends on networking + identity for workload principal IDs)
// =============================================================================

targetScope = 'subscription'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Target environment name.')
@allowed(['dev', 'prod'])
param environment string = 'prod'

@description('Primary Azure region for all resources.')
param location string = 'eastus2'

@description('Azure subscription ID where resources will be deployed.')
param subscriptionId string

@description('Azure AD tenant ID.')
param tenantId string

@description('Object IDs of AAD groups to grant AKS cluster-admin access.')
param adminGroupObjectIds array

@description('Object ID of the platform administrator AAD group for Key Vault access.')
param platformAdminGroupObjectId string

@description('Corporate IP address range used in NSG inbound rules.')
param corporateIpRange string = '10.0.0.0/8'

@description('Resource ID of the shared Azure Container Registry.')
param containerRegistryId string

@description('Number of days to retain Log Analytics data.')
@minValue(7)
@maxValue(730)
param logRetentionDays int = 90

@description('Resource tags applied to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Generated name variables
// ---------------------------------------------------------------------------
var storageAccountName = 'forgeadls${environment}'
var keyVaultName       = 'kv-forge-${environment}'

// Resource group names
var rgNetworking    = 'rg-forge-networking-${environment}'
var rgCompute       = 'rg-forge-compute-${environment}'
var rgOrchestration = 'rg-forge-orchestration-${environment}'
var rgData          = 'rg-forge-data-${environment}'
var rgSecurity      = 'rg-forge-security-${environment}'

// Common tags merged with required platform tags
var mergedTags = union(tags, {
  environment: environment
  platform: 'forge'
  managedBy: 'bicep'
})

// ---------------------------------------------------------------------------
// Resource Groups
// ---------------------------------------------------------------------------
resource rgNetworkingRes 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: rgNetworking
  location: location
  tags: mergedTags
}

resource rgComputeRes 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: rgCompute
  location: location
  tags: mergedTags
}

resource rgOrchestrationRes 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: rgOrchestration
  location: location
  tags: mergedTags
}

resource rgDataRes 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: rgData
  location: location
  tags: mergedTags
}

resource rgSecurityRes 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: rgSecurity
  location: location
  tags: mergedTags
}

// ---------------------------------------------------------------------------
// Step 1: Networking
// ---------------------------------------------------------------------------
module networking '../../modules/networking.bicep' = {
  name: 'networking-${environment}'
  scope: resourceGroup(rgNetworking)
  dependsOn: [rgNetworkingRes]
  params: {
    environment: environment
    location: location
    corporateIpRange: corporateIpRange
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 2: AKS Clusters (parallel, both depend on networking)
// Prod uses larger VM SKUs and higher min/max counts than dev.
// ---------------------------------------------------------------------------
module computeCluster '../../modules/aks.bicep' = {
  name: 'aks-compute-${environment}'
  scope: resourceGroup(rgCompute)
  dependsOn: [rgComputeRes]
  params: {
    environment: environment
    location: location
    clusterPurpose: 'compute'
    kubernetesVersion: '1.29'
    subnetId: networking.outputs.subnetIds.compute
    privateDnsZoneId: ''
    adminGroupObjectIds: adminGroupObjectIds
    containerRegistryId: containerRegistryId
    logRetentionDays: logRetentionDays
    tags: mergedTags
  }
}

module orchCluster '../../modules/aks.bicep' = {
  name: 'aks-orchestration-${environment}'
  scope: resourceGroup(rgOrchestration)
  dependsOn: [rgOrchestrationRes]
  params: {
    environment: environment
    location: location
    clusterPurpose: 'orchestration'
    kubernetesVersion: '1.29'
    subnetId: networking.outputs.subnetIds.orchestration
    privateDnsZoneId: ''
    adminGroupObjectIds: adminGroupObjectIds
    containerRegistryId: containerRegistryId
    logRetentionDays: logRetentionDays
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 3: Storage (GZRS for prod cross-zone and cross-region redundancy)
// ---------------------------------------------------------------------------
module storage '../../modules/storage.bicep' = {
  name: 'storage-${environment}'
  scope: resourceGroup(rgData)
  dependsOn: [rgDataRes]
  params: {
    storageAccountName: storageAccountName
    environment: environment
    location: location
    replicationType: 'GZRS'
    privateEndpointSubnetId: networking.outputs.subnetIds.privateEndpoints
    privateDnsZoneDfsId: networking.outputs.privateDnsZoneIds.dfs
    privateDnsZoneBlobId: networking.outputs.privateDnsZoneIds.blob
    logAnalyticsWorkspaceId: orchCluster.outputs.logAnalyticsWorkspaceId
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 4: Identity (depends on both AKS clusters + storage)
// ---------------------------------------------------------------------------
module identity '../../modules/identity.bicep' = {
  name: 'identity-${environment}'
  scope: resourceGroup(rgSecurity)
  dependsOn: [rgSecurityRes]
  params: {
    environment: environment
    location: location
    computeOidcIssuerUrl: computeCluster.outputs.oidcIssuerUrl
    orchestrationOidcIssuerUrl: orchCluster.outputs.oidcIssuerUrl
    storageAccountId: storage.outputs.storageAccountId
    // Key Vault role assignments are handled in keyvault.bicep to avoid
    // circular dependency. Identity module KV path is disabled here.
    keyVaultId: ''
    namespaces: {
      spark:   { namespace: 'spark-jobs', serviceAccountName: 'spark' }
      trino:   { namespace: 'trino',       serviceAccountName: 'trino' }
      airflow: { namespace: 'airflow',     serviceAccountName: 'airflow' }
      dq:      { namespace: 'dq',          serviceAccountName: 'dq-runner' }
      portal:  { namespace: 'portal',      serviceAccountName: 'portal-api' }
      lineage: { namespace: 'lineage',     serviceAccountName: 'marquez' }
    }
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 5: Key Vault (depends on networking + identity for principal IDs)
// ---------------------------------------------------------------------------
module keyvault '../../modules/keyvault.bicep' = {
  name: 'keyvault-${environment}'
  scope: resourceGroup(rgSecurity)
  dependsOn: [rgSecurityRes]
  params: {
    keyVaultName: keyVaultName
    environment: environment
    location: location
    tenantId: tenantId
    privateEndpointSubnetId: networking.outputs.subnetIds.privateEndpoints
    privateDnsZoneVaultId: networking.outputs.privateDnsZoneIds.vault
    platformAdminGroupObjectId: platformAdminGroupObjectId
    workloadPrincipalIds: {
      spark:   identity.outputs.identities.spark.principalId
      trino:   identity.outputs.identities.trino.principalId
      airflow: identity.outputs.identities.airflow.principalId
      dq:      identity.outputs.identities.dq.principalId
      portal:  identity.outputs.identities.portal.principalId
      lineage: identity.outputs.identities.lineage.principalId
    }
    logAnalyticsWorkspaceId: orchCluster.outputs.logAnalyticsWorkspaceId
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

// Networking
output vnetId string = networking.outputs.vnetId
output vnetName string = networking.outputs.vnetName
output subnetIds object = networking.outputs.subnetIds
output privateDnsZoneIds object = networking.outputs.privateDnsZoneIds
output bastionId string = networking.outputs.bastionId

// Storage
output storageAccountId string = storage.outputs.storageAccountId
output storageAccountName string = storage.outputs.storageAccountName
output dfsEndpoint string = storage.outputs.dfsEndpoint
output blobEndpoint string = storage.outputs.blobEndpoint
output storageContainerIds object = storage.outputs.containerIds

// Key Vault
output keyVaultId string = keyvault.outputs.keyVaultId
output keyVaultUri string = keyvault.outputs.keyVaultUri

// AKS — Compute
output computeClusterId string = computeCluster.outputs.clusterId
output computeClusterName string = computeCluster.outputs.clusterName
output computeClusterFqdn string = computeCluster.outputs.clusterFqdn
output computeOidcIssuerUrl string = computeCluster.outputs.oidcIssuerUrl
output computeLogAnalyticsWorkspaceId string = computeCluster.outputs.logAnalyticsWorkspaceId

// AKS — Orchestration
output orchClusterId string = orchCluster.outputs.clusterId
output orchClusterName string = orchCluster.outputs.clusterName
output orchClusterFqdn string = orchCluster.outputs.clusterFqdn
output orchOidcIssuerUrl string = orchCluster.outputs.oidcIssuerUrl
output orchLogAnalyticsWorkspaceId string = orchCluster.outputs.logAnalyticsWorkspaceId

// Workload Identities
output workloadIdentities object = identity.outputs.identities
