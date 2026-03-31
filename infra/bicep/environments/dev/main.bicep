// =============================================================================
// Forge Data Platform — Dev Environment Root Template
// Subscription-scoped orchestration template that provisions resource groups
// and calls all platform modules in dependency order.
//
// Prerequisites:
//   1. Run shared/main.bicep once to create rg-forge-acr and ACR.
//   2. Pass the ACR resource ID as containerRegistryId parameter.
//
// Resource groups created by this template (dev):
//   - rg-forge-platform-dev  : VNet, NSGs, DNS zones, LAW
//   - rg-forge-dev           : AKS clusters (compute + orchestration), ADLS, Key Vault, managed identities
//
// Deployment order:
//   1. Resource Groups (parallel)
//   2. Networking  (→ rg-forge-platform-dev)
//   3. AKS clusters (compute + orchestration, parallel, both → rg-forge-dev)
//   4. Storage      (→ rg-forge-dev, depends on networking)
//   5. Identity     (→ rg-forge-dev, depends on AKS + storage)
//   6. Key Vault    (→ rg-forge-dev, depends on networking + identity)
//   7. PostgreSQL   (→ rg-forge-dev, depends on networking + keyvault)
//
// Deploy:
//   az deployment sub create \
//     --location northcentralus \
//     --template-file infra/bicep/environments/dev/main.bicep \
//     --parameters @infra/bicep/environments/dev/dev.parameters.json
// =============================================================================

targetScope = 'subscription'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Target environment name.')
@allowed(['dev', 'prod'])
param environment string

@description('Primary Azure region for all resources.')
param location string

@description('Azure AD tenant ID.')
param tenantId string

@description('Object IDs of AAD groups to grant AKS cluster-admin access.')
param adminGroupObjectIds array

@description('Object ID of the platform administrator AAD group for Key Vault access.')
param platformAdminGroupObjectId string

@description('Owner alias appended to resource names for personal deployment disambiguation (e.g., prproddu01). Leave empty for shared environments.')
param ownerAlias string

@description('Number of days to retain Log Analytics data. S360 LM requires minimum 90 days.')
@minValue(90)
@maxValue(730)
param logRetentionDays int = 90

// Compute cluster sizing
@description('VM size for the compute system node pool.')
param computeSystemVmSize string = 'Standard_D4s_v5'

@description('System pool node count for the compute cluster.')
param computeSystemNodeCount int = 1

@description('VM size for the Spark node pool.')
param sparkVmSize string = 'Standard_E8s_v5'

@description('Max autoscale nodes for the Spark pool.')
param sparkMaxNodes int = 10

@description('VM size for the Trino node pool.')
param trinoVmSize string = 'Standard_D4s_v5'

@description('Max autoscale nodes for the Trino pool.')
param trinoMaxNodes int = 5

// Orchestration cluster sizing
@description('VM size for the orchestration system node pool.')
param orchSystemVmSize string = 'Standard_D4s_v5'

@description('System pool node count for the orchestration cluster.')
param orchSystemNodeCount int = 1

@description('VM size for the orchestration worker pool (Airflow, DQ, Portal).')
param orchWorkerVmSize string = 'Standard_D4s_v5'

@description('Max autoscale nodes for the orchestration worker pool.')
param orchWorkerMaxNodes int = 5

@description('Kubernetes version to deploy on both AKS clusters.')
param kubernetesVersion string = '1.32'

@description('Storage account replication type. Use LRS for dev (cost), ZRS or GRS for prod (durability).')
@allowed(['LRS', 'ZRS', 'GRS', 'GZRS', 'RAGRS', 'RAGZRS'])
param storageReplicationType string = 'LRS'

@description('Allow public network access to Key Vault. Set true for dev (enables CLI access without VPN). Prod defaults to false.')
param kvAllowPublicNetworkAccess bool = false

@description('Resource tags applied to all resources.')
param tags object = {}


// ---------------------------------------------------------------------------
// Generated name variables
// ---------------------------------------------------------------------------
var aliasSuffix = ownerAlias != '' ? '-${ownerAlias}' : ''

// Shared ACR resource ID — derived from ownerAlias to match shared/main.bicep naming
var acrRegistryName = ownerAlias != '' ? 'forgeacr${ownerAlias}' : 'forgeacr'
var acrRgName       = ownerAlias != '' ? 'rg-forge-acr-${ownerAlias}' : 'rg-forge-acr'

// Storage account names cannot contain hyphens; embed alias directly
var storageAccountName = 'forgeadls${ownerAlias}${environment}'
var keyVaultName       = 'kv-forge${aliasSuffix}-${environment}'

// Resource group names — 2 RGs per environment
var rgPlatform = 'rg-forge-platform${aliasSuffix}-${environment}'
var rgCompute  = 'rg-forge${aliasSuffix}-${environment}'

// PostgreSQL Flexible Server name — globally unique, no hyphens in embedded alias
var postgresServerName = 'psql-forge${aliasSuffix}-${environment}'

// Common tags merged with required platform tags
var mergedTags = union(tags, {
  environment: environment
  platform: 'forge'
  managedBy: 'bicep'
})

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
// Step 1: Networking  (→ rg-forge-platform-dev)
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
// Step 1b: ACR Private Endpoint  (→ rg-forge-platform-dev, depends on networking)
// Attaches the shared ACR to this environment's VNet via a private endpoint.
// ---------------------------------------------------------------------------
module acrPrivateEndpoint '../../modules/acr-pe.bicep' = {
  name: 'acr-pe-${environment}'
  scope: resourceGroup(rgPlatform)
  params: {
    acrResourceId: resourceId(subscription().subscriptionId, acrRgName, 'Microsoft.ContainerRegistry/registries', acrRegistryName)
    privateEndpointName: 'pe-${acrRegistryName}-${environment}'
    location: location
    privateEndpointSubnetId: networking.outputs.subnetIds.privateEndpoints
    privateDnsZoneAcrId: networking.outputs.privateDnsZoneIds.acr
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 2: Log Analytics Workspaces  (→ rg-forge-dev)
// Must deploy before AKS — AKS preflight calls sharedKeys on the workspace
// during validation, which fails if the workspace doesn't exist yet.
// ---------------------------------------------------------------------------
module computeLaw '../../modules/law.bicep' = {
  name: 'law-compute-${environment}'
  scope: resourceGroup(rgCompute)
  dependsOn: [rgComputeRes]
  params: {
    lawName: 'law-forge-compute${aliasSuffix}-${environment}'
    location: location
    logRetentionDays: logRetentionDays
    tags: mergedTags
  }
}

module orchLaw '../../modules/law.bicep' = {
  name: 'law-orchestration-${environment}'
  scope: resourceGroup(rgCompute)
  dependsOn: [rgComputeRes]
  params: {
    lawName: 'law-forge-orchestration${aliasSuffix}-${environment}'
    location: location
    logRetentionDays: logRetentionDays
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 3: AKS Clusters  (→ rg-forge-dev, parallel, depend on LAWs)
// ---------------------------------------------------------------------------
module computeCluster '../../modules/aks.bicep' = {
  name: 'aks-compute-${environment}'
  scope: resourceGroup(rgCompute)
  params: {
    environment: environment
    location: location
    ownerAlias: ownerAlias
    clusterPurpose: 'compute'
    kubernetesVersion: kubernetesVersion
    systemVmSize: computeSystemVmSize
    systemNodeCount: computeSystemNodeCount
    sparkVmSize: sparkVmSize
    sparkMaxNodes: sparkMaxNodes
    trinoVmSize: trinoVmSize
    trinoMaxNodes: trinoMaxNodes
    subnetId: networking.outputs.subnetIds.compute
    adminGroupObjectIds: adminGroupObjectIds
    logAnalyticsWorkspaceId: computeLaw.outputs.id
    tags: mergedTags
  }
}

module orchCluster '../../modules/aks.bicep' = {
  name: 'aks-orchestration-${environment}'
  scope: resourceGroup(rgCompute)
  params: {
    environment: environment
    location: location
    ownerAlias: ownerAlias
    clusterPurpose: 'orchestration'
    kubernetesVersion: kubernetesVersion
    systemVmSize: orchSystemVmSize
    systemNodeCount: orchSystemNodeCount
    workerVmSize: orchWorkerVmSize
    workerMaxNodes: orchWorkerMaxNodes
    subnetId: networking.outputs.subnetIds.orchestration
    adminGroupObjectIds: adminGroupObjectIds
    logAnalyticsWorkspaceId: orchLaw.outputs.id
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
// AKS Network Contributor (cross-RG: AKS control plane → VNet)
// Required for AKS to manage load balancers and NIC configurations in the VNet.
// ---------------------------------------------------------------------------
module aksComputeNetworkRbac '../../modules/rbac-aks-network.bicep' = {
  name: 'rbac-aks-network-compute-${environment}'
  scope: resourceGroup(rgPlatform)
  params: {
    vnetName: networking.outputs.vnetName
    controlPlanePrincipalId: computeCluster.outputs.controlPlanePrincipalId
  }
}

module aksOrchNetworkRbac '../../modules/rbac-aks-network.bicep' = {
  name: 'rbac-aks-network-orch-${environment}'
  scope: resourceGroup(rgPlatform)
  params: {
    vnetName: networking.outputs.vnetName
    controlPlanePrincipalId: orchCluster.outputs.controlPlanePrincipalId
  }
}

// ---------------------------------------------------------------------------
// Step 4: Storage  (→ rg-forge-dev, depends on networking + orchLaw)
// The orchestration LAW is used as the primary diagnostic sink for storage
// so that operational logs are co-located with Airflow / DQ.
// ---------------------------------------------------------------------------
module storage '../../modules/storage.bicep' = {
  name: 'storage-${environment}'
  scope: resourceGroup(rgCompute)
  dependsOn: [rgComputeRes]
  params: {
    storageAccountName: storageAccountName
    location: location
    replicationType: storageReplicationType
    privateEndpointSubnetId: networking.outputs.subnetIds.privateEndpoints
    privateDnsZoneDfsId: networking.outputs.privateDnsZoneIds.dfs
    privateDnsZoneBlobId: networking.outputs.privateDnsZoneIds.blob
    logAnalyticsWorkspaceId: orchLaw.outputs.id
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 5: Identity  (→ rg-forge-dev, depends on AKS clusters + storage)
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
    // Key Vault ID is empty here; KV role assignments are managed in keyvault.bicep.
    keyVaultId: ''
    namespaces: {
      spark:   { namespace: 'spark-system',   serviceAccountName: 'spark' }
      trino:   { namespace: 'trino',          serviceAccountName: 'trino' }
      airflow: { namespace: 'airflow',        serviceAccountName: 'airflow' }
      dq:      { namespace: 'dq',            serviceAccountName: 'dq-runner' }
      portal:  { namespace: 'portal',        serviceAccountName: 'portal-api' }
      hms:     { namespace: 'hive-metastore', serviceAccountName: 'hive-metastore' }
    }
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 6: Key Vault  (→ rg-forge-dev, depends on networking + identity)
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
    }
    logAnalyticsWorkspaceId: orchLaw.outputs.id
    allowPublicNetworkAccess: kvAllowPublicNetworkAccess
    tags: mergedTags
  }
}

// ---------------------------------------------------------------------------
// Step 7: PostgreSQL Flexible Server  (→ rg-forge-dev, depends on networking + keyvault)
// HMS metadata backend. Uses VNet Integration — no public access.
// ---------------------------------------------------------------------------
module postgres '../../modules/postgres.bicep' = {
  name: 'postgres-${environment}'
  scope: resourceGroup(rgCompute)
  params: {
    environment: environment
    location: location
    serverName: postgresServerName
    subnetId: networking.outputs.subnetIds.postgres
    privateDnsZoneId: networking.outputs.privateDnsZoneIds.postgres
    keyVaultId: keyvault.outputs.keyVaultId
    hmsManagedIdentityPrincipalId: identity.outputs.identities.hms.principalId
    hmsManagedIdentityName: identity.outputs.identities.hms.name
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

// PostgreSQL (HMS backend)
output postgresServerName string = postgres.outputs.serverName
output postgresServerFqdn string = postgres.outputs.serverFqdn
