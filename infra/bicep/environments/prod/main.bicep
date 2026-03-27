// =============================================================================
// Forge Data Platform — Prod Environment Root Template
// Subscription-scoped orchestration template that provisions resource groups
// and calls all platform modules in dependency order.
//
// Prerequisites:
//   1. Run shared/main.bicep once to create rg-forge-acr and ACR.
//   2. Pass the ACR resource ID as containerRegistryId parameter.
//
// Resource groups created by this template (prod):
//   - rg-forge-platform-prod : VNet, NSGs, DNS zones, Bastion, LAW
//   - rg-forge-compute-prod  : AKS clusters, ADLS, Key Vault, managed identities
//
// Deployment order:
//   1. Resource Groups (parallel)
//   2. Networking  (→ rg-forge-platform-prod)
//   3. AKS clusters (compute + orchestration, parallel, both → rg-forge-compute-prod)
//   4. Storage      (→ rg-forge-compute-prod, GZRS for cross-zone + cross-region redundancy)
//   5. Identity     (→ rg-forge-compute-prod, depends on AKS + storage)
//   6. Key Vault    (→ rg-forge-compute-prod, depends on networking + identity)
//
// Deploy:
//   az deployment sub create \
//     --location northcentralus \
//     --template-file infra/bicep/environments/prod/main.bicep \
//     --parameters @infra/bicep/environments/prod/prod.parameters.json
// =============================================================================

targetScope = 'subscription'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Target environment name.')
@allowed(['dev', 'prod'])
param environment string = 'prod'

@description('Primary Azure region for all resources.')
param location string = 'northcentralus'

@description('Azure subscription ID where resources will be deployed.')
param subscriptionId string

@description('Azure AD tenant ID.')
param tenantId string

@description('Object IDs of AAD groups to grant AKS cluster-admin access.')
param adminGroupObjectIds array

@description('Object ID of the platform administrator AAD group for Key Vault access.')
param platformAdminGroupObjectId string

@description('Number of days to retain Log Analytics data. S360 LM requires minimum 90 days.')
@minValue(90)
@maxValue(730)
param logRetentionDays int = 90

@description('Owner alias appended to top-level resource names. Leave empty (default) for production shared environments.')
param ownerAlias string = ''

@description('Resource tags applied to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Generated name variables
// ---------------------------------------------------------------------------
var aliasSuffix = ownerAlias != '' ? '-${ownerAlias}' : ''

// Shared ACR resource ID — derived from ownerAlias to match shared/main.bicep naming
var acrRegistryName = ownerAlias != '' ? 'forgeacr${ownerAlias}' : 'forgeacr'
var acrRgName       = ownerAlias != '' ? 'rg-forge-acr-${ownerAlias}' : 'rg-forge-acr'

var storageAccountName = 'forgeadls${ownerAlias}${environment}'
var keyVaultName       = 'kv-forge${aliasSuffix}-${environment}'

// Resource group names — 2 RGs per environment
var rgPlatform = 'rg-forge-platform${aliasSuffix}-${environment}'
var rgCompute  = 'rg-forge-compute${aliasSuffix}-${environment}'

// Common tags merged with required platform tags
var mergedTags = union(tags, {
  environment: environment
  platform: 'forge'
  managedBy: 'bicep'
})

// ---------------------------------------------------------------------------
// Microsoft Defender for Containers — subscription-level plan
// S360: Covers ACR image scanning + AKS runtime threat detection.
// Deployed at subscription scope (this template's targetScope).
// ---------------------------------------------------------------------------
resource defenderForContainers 'Microsoft.Security/pricings@2024-01-01' = {
  name: 'Containers'
  properties: {
    pricingTier: 'Standard'
  }
}

// ---------------------------------------------------------------------------
// Resource Groups
// ---------------------------------------------------------------------------
resource rgPlatformRes 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: rgPlatform
  location: location
  tags: mergedTags
}

resource rgComputeRes 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: rgCompute
  location: location
  tags: mergedTags
}

// ---------------------------------------------------------------------------
// Step 1: Networking  (→ rg-forge-platform-prod)
// ---------------------------------------------------------------------------
module networking '../../modules/networking.bicep' = {
  name: 'networking-${environment}'
  scope: resourceGroup(rgPlatform)
  dependsOn: [rgPlatformRes]
  params: {
    environment: environment
    location: location
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 1b: ACR Private Endpoint  (→ rg-forge-platform-prod, depends on networking)
// ---------------------------------------------------------------------------
module acrPrivateEndpoint '../../modules/acr.bicep' = {
  name: 'acr-pe-${environment}'
  scope: resourceGroup(rgPlatform)
  dependsOn: [rgPlatformRes]
  params: {
    registryName: acrRegistryName
    location: location
    privateEndpointSubnetId: networking.outputs.subnetIds.privateEndpoints
    privateDnsZoneAcrId: networking.outputs.privateDnsZoneIds.acr
    logAnalyticsWorkspaceId: networking.outputs.platformLogAnalyticsWorkspaceId
    exportPolicyEnabled: false
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 2: AKS Clusters  (→ rg-forge-compute-prod, parallel, depend on networking)
// Prod uses larger VM SKUs and higher min/max counts than dev.
// ---------------------------------------------------------------------------
module computeCluster '../../modules/aks.bicep' = {
  name: 'aks-compute-${environment}'
  scope: resourceGroup(rgCompute)
  dependsOn: [rgComputeRes]
  params: {
    environment: environment
    location: location
    ownerAlias: ownerAlias
    clusterPurpose: 'compute'
    kubernetesVersion: '1.32'
    sparkVmSize: 'Standard_E96_v5'    // 96 vCPUs / 672 GiB — 4c/28g executors fill nodes exactly
    subnetId: networking.outputs.subnetIds.compute
    privateDnsZoneId: ''
    adminGroupObjectIds: adminGroupObjectIds
    logRetentionDays: logRetentionDays
    tags: mergedTags
  }
}

module orchCluster '../../modules/aks.bicep' = {
  name: 'aks-orchestration-${environment}'
  scope: resourceGroup(rgCompute)
  dependsOn: [rgComputeRes]
  params: {
    environment: environment
    location: location
    ownerAlias: ownerAlias
    clusterPurpose: 'orchestration'
    kubernetesVersion: '1.32'
    subnetId: networking.outputs.subnetIds.orchestration
    privateDnsZoneId: ''
    adminGroupObjectIds: adminGroupObjectIds
    logRetentionDays: logRetentionDays
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// ACR Pull role assignments (cross-RG: AKS kubelet → shared ACR)
// ---------------------------------------------------------------------------
module acrPullCompute '../../modules/rbac-acr-pull.bicep' = {
  name: 'acr-pull-compute-${environment}'
  scope: resourceGroup(acrRgName)
  params: {
    registryName: acrRegistryName
    principalId: computeCluster.outputs.kubeletIdentityObjectId
  }
}

module acrPullOrch '../../modules/rbac-acr-pull.bicep' = {
  name: 'acr-pull-orch-${environment}'
  scope: resourceGroup(acrRgName)
  params: {
    registryName: acrRegistryName
    principalId: orchCluster.outputs.kubeletIdentityObjectId
  }
}

// ---------------------------------------------------------------------------
// Step 3: Storage  (→ rg-forge-compute-prod, GZRS for cross-zone + cross-region)
// ---------------------------------------------------------------------------
module storage '../../modules/storage.bicep' = {
  name: 'storage-${environment}'
  scope: resourceGroup(rgCompute)
  dependsOn: [rgComputeRes]
  params: {
    storageAccountName: storageAccountName
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
// Step 4: Identity  (→ rg-forge-compute-prod, depends on AKS clusters + storage)
// ---------------------------------------------------------------------------
module identity '../../modules/identity.bicep' = {
  name: 'identity-${environment}'
  scope: resourceGroup(rgCompute)
  dependsOn: [rgComputeRes]
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
      trino:   { namespace: 'trino',      serviceAccountName: 'trino' }
      airflow: { namespace: 'airflow',    serviceAccountName: 'airflow' }
      dq:      { namespace: 'dq',         serviceAccountName: 'dq-runner' }
      portal:  { namespace: 'portal',     serviceAccountName: 'portal-api' }
      lineage: { namespace: 'lineage',    serviceAccountName: 'purview' }
    }
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 5: Key Vault  (→ rg-forge-compute-prod, depends on networking + identity)
// ---------------------------------------------------------------------------
module keyvault '../../modules/keyvault.bicep' = {
  name: 'keyvault-${environment}'
  scope: resourceGroup(rgCompute)
  dependsOn: [rgComputeRes]
  params: {
    keyVaultName: keyVaultName
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
