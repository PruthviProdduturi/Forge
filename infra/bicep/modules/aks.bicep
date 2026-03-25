// =============================================================================
// Forge Data Platform — AKS Module
// Provisions a private AKS cluster with workload identity, OIDC issuer,
// diagnostics, and purpose-specific node pools.
// =============================================================================

@description('Target environment name (dev or prod).')
@allowed(['dev', 'prod'])
param environment string

@description('Azure region for all resources.')
param location string

@description('Cluster purpose determines node pools and network CIDR allocation.')
@allowed(['compute', 'orchestration'])
param clusterPurpose string

@description('Kubernetes version to deploy.')
param kubernetesVersion string = '1.29'

@description('Resource ID of the subnet to place the AKS nodes in.')
param subnetId string

@description('Resource ID of the private DNS zone for AKS private cluster. Empty string uses system-managed zone.')
param privateDnsZoneId string = ''

@description('AAD group object IDs to grant cluster-admin access via Azure RBAC.')
param adminGroupObjectIds array

@description('Resource ID of the Azure Container Registry to grant pull access.')
param containerRegistryId string

@description('Number of days to retain Log Analytics data.')
@minValue(7)
@maxValue(730)
param logRetentionDays int = 30

@description('Resource tags to apply to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Derived variables
// ---------------------------------------------------------------------------
var clusterName = 'aks-forge-${clusterPurpose}-${environment}'
var kubeletIdentityName = 'id-aks-kubelet-${clusterPurpose}-${environment}'
var lawName = 'law-forge-${clusterPurpose}-${environment}'

// Network CIDRs differ per cluster to avoid overlap
var podCidr = clusterPurpose == 'compute' ? '10.100.0.0/16' : '10.101.0.0/16'
var serviceCidr = clusterPurpose == 'compute' ? '10.200.0.0/16' : '10.201.0.0/16'
var dnsServiceIP = clusterPurpose == 'compute' ? '10.200.0.10' : '10.201.0.10'

// Resolve private DNS zone: 'system' tells AKS to auto-manage the zone
var resolvedPrivateDnsZone = privateDnsZoneId == '' ? 'system' : privateDnsZoneId

// ACR pull role definition ID (AcrPull)
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

// Reference the ACR as an existing resource so the role assignment can be
// scoped directly to it (ACR may be in a different resource group).
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: last(split(containerRegistryId, '/'))
  scope: resourceGroup(split(containerRegistryId, '/')[2], split(containerRegistryId, '/')[4])
}

// ---------------------------------------------------------------------------
// Log Analytics Workspace
// ---------------------------------------------------------------------------
resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: lawName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: 'Disabled'
  }
}

// ---------------------------------------------------------------------------
// User-assigned Managed Identity for kubelet
// ---------------------------------------------------------------------------
resource kubeletIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: kubeletIdentityName
  location: location
  tags: tags
}

// The AKS control plane also needs its own identity
resource aksControlPlaneIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-aks-controlplane-${clusterPurpose}-${environment}'
  location: location
  tags: tags
}

// ---------------------------------------------------------------------------
// AKS Cluster
// ---------------------------------------------------------------------------
resource aksCluster 'Microsoft.ContainerService/managedClusters@2024-01-01' = {
  name: clusterName
  location: location
  tags: tags
  sku: {
    name: 'Base'
    tier: 'Standard'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${aksControlPlaneIdentity.id}': {}
    }
  }
  properties: {
    dnsPrefix: 'forge-${clusterPurpose}-${environment}'
    kubernetesVersion: kubernetesVersion
    disableLocalAccounts: true

    // AAD / RBAC
    aadProfile: {
      managed: true
      enableAzureRBAC: true
      adminGroupObjectIDs: adminGroupObjectIds
    }

    // Agent pool — system pool only; additional pools are separate resources
    agentPoolProfiles: [
      {
        name: 'systempool'
        vmSize: 'Standard_D4s_v5'
        count: 2
        minCount: 2
        maxCount: 4
        enableAutoScaling: true
        osType: 'Linux'
        osSKU: 'AzureLinux'
        mode: 'System'
        type: 'VirtualMachineScaleSets'
        vnetSubnetID: subnetId
        enableNodePublicIP: false
        nodeTaints: ['CriticalAddonsOnly=true:NoSchedule']
        upgradeSettings: {
          maxSurge: '33%'
        }
      }
    ]

    // Network profile — CNI Overlay with Calico policy
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      networkPolicy: 'calico'
      podCidr: podCidr
      serviceCidr: serviceCidr
      dnsServiceIP: dnsServiceIP
      outboundType: 'userDefinedRouting'
      loadBalancerSku: 'standard'
    }

    // Private cluster configuration
    apiServerAccessProfile: {
      enablePrivateCluster: true
      privateDNSZone: resolvedPrivateDnsZone
      enablePrivateClusterPublicFQDN: false
    }

    // Kubelet identity (user-assigned)
    identityProfile: {
      kubeletidentity: {
        resourceId: kubeletIdentity.id
        clientId: kubeletIdentity.properties.clientId
        objectId: kubeletIdentity.properties.principalId
      }
    }

    // OIDC issuer for workload identity federation
    oidcIssuerProfile: {
      enabled: true
    }

    // Workload identity and security features
    securityProfile: {
      workloadIdentity: {
        enabled: true
      }
      imageCleaner: {
        enabled: true
        intervalHours: 48
      }
    }

    // Auto-scaler — KEDA disabled; Spark Operator handles scaling
    workloadAutoScalerProfile: {
      keda: {
        enabled: false
      }
    }

    // Add-ons
    addonProfiles: {
      omsagent: {
        enabled: true
        config: {
          logAnalyticsWorkspaceResourceID: law.id
          useAADAuth: 'true'
        }
      }
      azurePolicy: {
        enabled: true
      }
      azureKeyvaultSecretsProvider: {
        enabled: true
        config: {
          enableSecretRotation: 'true'
          rotationPollInterval: '2m'
        }
      }
    }

    // Auto upgrade channel — patch only for stability
    autoUpgradeProfile: {
      upgradeChannel: 'patch'
    }
  }
}

// Maintenance configuration is a separate child resource of type
// Microsoft.ContainerService/managedClusters/maintenanceConfigurations.
// It is omitted here as it is environment-specific and can be applied post-deploy
// via: az aks maintenanceconfiguration add --cluster-name ... --name default
// with a notAllowedTime window covering business hours.

// ---------------------------------------------------------------------------
// Additional node pools — compute cluster
// ---------------------------------------------------------------------------
resource sparkPool 'Microsoft.ContainerService/managedClusters/agentPools@2024-01-01' = if (clusterPurpose == 'compute') {
  parent: aksCluster
  name: 'sparkpool'
  properties: {
    vmSize: 'Standard_E8s_v5'
    count: 0
    minCount: 0
    maxCount: 20
    enableAutoScaling: true
    osType: 'Linux'
    osSKU: 'AzureLinux'
    mode: 'User'
    type: 'VirtualMachineScaleSets'
    vnetSubnetID: subnetId
    enableNodePublicIP: false
    nodeLabels: {
      workload: 'spark'
    }
    nodeTaints: ['workload=spark:NoSchedule']
    upgradeSettings: {
      maxSurge: '33%'
    }
    scaleSetEvictionPolicy: 'Delete'
    spotMaxPrice: -1
  }
}

resource trinoPool 'Microsoft.ContainerService/managedClusters/agentPools@2024-01-01' = if (clusterPurpose == 'compute') {
  parent: aksCluster
  name: 'trinopool'
  properties: {
    vmSize: 'Standard_D8s_v5'
    count: 0
    minCount: 0
    maxCount: 10
    enableAutoScaling: true
    osType: 'Linux'
    osSKU: 'AzureLinux'
    mode: 'User'
    type: 'VirtualMachineScaleSets'
    vnetSubnetID: subnetId
    enableNodePublicIP: false
    nodeLabels: {
      workload: 'trino'
    }
    nodeTaints: ['workload=trino:NoSchedule']
    upgradeSettings: {
      maxSurge: '33%'
    }
  }
}

// ---------------------------------------------------------------------------
// Additional node pools — orchestration cluster
// ---------------------------------------------------------------------------
resource workerPool 'Microsoft.ContainerService/managedClusters/agentPools@2024-01-01' = if (clusterPurpose == 'orchestration') {
  parent: aksCluster
  name: 'workerpool'
  properties: {
    vmSize: 'Standard_D4s_v5'
    count: 2
    minCount: 2
    maxCount: 20
    enableAutoScaling: true
    osType: 'Linux'
    osSKU: 'AzureLinux'
    mode: 'User'
    type: 'VirtualMachineScaleSets'
    vnetSubnetID: subnetId
    enableNodePublicIP: false
    nodeLabels: {
      workload: 'general'
    }
    upgradeSettings: {
      maxSurge: '33%'
    }
  }
}

// ---------------------------------------------------------------------------
// ACR Pull role assignment for kubelet identity
// ---------------------------------------------------------------------------
resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kubeletIdentity.properties.principalId, acrPullRoleId, containerRegistryId)
  scope: containerRegistry
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: kubeletIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Allow AKS kubelet identity to pull images from ACR for ${clusterName}'
  }
}

// ---------------------------------------------------------------------------
// Diagnostic settings — send control plane logs to Log Analytics
// ---------------------------------------------------------------------------
resource aksDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-${clusterName}'
  scope: aksCluster
  properties: {
    workspaceId: law.id
    logs: [
      {
        category: 'kube-apiserver'
        enabled: true
      }
      {
        category: 'kube-audit'
        enabled: true
      }
      {
        category: 'kube-audit-admin'
        enabled: true
      }
      {
        category: 'kube-controller-manager'
        enabled: true
      }
      {
        category: 'kube-scheduler'
        enabled: true
      }
      {
        category: 'cluster-autoscaler'
        enabled: true
      }
      {
        category: 'cloud-controller-manager'
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
output clusterId string = aksCluster.id
output clusterName string = aksCluster.name
output clusterFqdn string = aksCluster.properties.privateFQDN
output oidcIssuerUrl string = aksCluster.properties.oidcIssuerProfile.issuerURL
output kubeletIdentityObjectId string = kubeletIdentity.properties.principalId
output kubeletIdentityClientId string = kubeletIdentity.properties.clientId
output logAnalyticsWorkspaceId string = law.id
