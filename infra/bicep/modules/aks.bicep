// =============================================================================
// Forge Data Platform — AKS Module
// Provisions a private AKS cluster with workload identity, OIDC issuer,
// diagnostics, and purpose-specific node pools.
// The Log Analytics Workspace must be deployed BEFORE this module via the
// law.bicep module, as AKS preflight validation calls sharedKeys on the
// workspace during deployment validation.
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
param kubernetesVersion string = '1.32'

@description('Resource ID of the subnet to place the AKS nodes in.')
param subnetId string

@description('AAD group object IDs to grant cluster-admin access via Azure RBAC.')
param adminGroupObjectIds array

@description('Resource ID of the Log Analytics workspace for OMS addon, Defender, and diagnostics. Must exist before this module deploys.')
param logAnalyticsWorkspaceId string

@description('Owner alias appended to resource names for personal/shared deployment disambiguation (e.g., prproddu). Leave empty for shared environments.')
param ownerAlias string = ''

@description('VM size for the system node pool.')
param systemVmSize string = 'Standard_D4s_v5'

@description('System node pool initial and minimum node count.')
param systemNodeCount int = 1

@description('VM size for the Spark node pool (compute cluster only).')
param sparkVmSize string = 'Standard_E8s_v5'

@description('Maximum autoscale node count for the Spark pool (compute cluster only).')
param sparkMaxNodes int = 10

@description('VM size for the Trino node pool (compute cluster only).')
param trinoVmSize string = 'Standard_D4s_v5'

@description('Maximum autoscale node count for the Trino pool (compute cluster only).')
param trinoMaxNodes int = 5

@description('VM size for the orchestration worker pool.')
param workerVmSize string = 'Standard_D4s_v5'

@description('Maximum autoscale node count for the orchestration worker pool.')
param workerMaxNodes int = 5

@description('Resource tags to apply to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Derived variables
// ---------------------------------------------------------------------------
var aliasSuffix = ownerAlias != '' ? '-${ownerAlias}' : ''
var purposeShort = clusterPurpose == 'orchestration' ? 'orch' : clusterPurpose
var clusterName = 'aks-forge-${clusterPurpose}${aliasSuffix}-${environment}'
var kubeletIdentityName = 'id-aks-kubelet-${clusterPurpose}${aliasSuffix}-${environment}'
// Explicit node RG name — AKS auto-generates MC_{rg}_{cluster}_{region} which
// can exceed 80 chars. rg-mc-{purpose}-{alias}-{env} stays well under the limit.
var nodeResourceGroupName = 'rg-mc-${purposeShort}${aliasSuffix}-${environment}'

// Network CIDRs differ per cluster to avoid overlap
var podCidr = clusterPurpose == 'compute' ? '10.100.0.0/16' : '10.101.0.0/16'
var serviceCidr = clusterPurpose == 'compute' ? '10.200.0.0/16' : '10.201.0.0/16'
var dnsServiceIP = clusterPurpose == 'compute' ? '10.200.0.10' : '10.201.0.10'


// ---------------------------------------------------------------------------
// Outbound public IP for AKS load balancer (SNAT egress)
// Pre-created so we control ipTags — required for S360 NS2.1.1 compliance.
// ipTags classify the IP as /NonProd (dev) or /Prod (prod) for Microsoft's
// service tag system. AKS-auto-created IPs cannot have ipTags set post hoc.
// ---------------------------------------------------------------------------
resource outboundPublicIp 'Microsoft.Network/publicIPAddresses@2023-06-01' = {
  name: 'pip-${clusterName}-outbound'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    ipTags: [
      {
        ipTagType: 'FirstPartyUsage'
        tag: environment == 'prod' ? '/Prod' : '/NonProd'
      }
    ]
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
  name: 'id-aks-controlplane-${clusterPurpose}${aliasSuffix}-${environment}'
  location: location
  tags: tags
}

// Control plane identity must have Managed Identity Operator on the kubelet
// identity so AKS can assign it to nodes during cluster creation.
var managedIdentityOperatorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f1a07417-d97a-45cb-824c-7a7467783830')

resource controlPlaneKubeletRbac 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aksControlPlaneIdentity.id, managedIdentityOperatorRoleId, kubeletIdentity.id)
  scope: kubeletIdentity
  properties: {
    roleDefinitionId: managedIdentityOperatorRoleId
    principalId: aksControlPlaneIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
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
    nodeResourceGroup: nodeResourceGroupName
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
        vmSize: systemVmSize
        count: systemNodeCount
        minCount: systemNodeCount
        maxCount: systemNodeCount * 2
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
      // loadBalancer: pre-created public IP with S360 ipTags is used for SNAT
      // egress so nodes can reach Ubuntu/k8s apt repos during provisioning.
      // Switch to userDefinedRouting when Azure Firewall is deployed in prod.
      outboundType: 'loadBalancer'
      loadBalancerSku: 'standard'
      loadBalancerProfile: {
        outboundIPs: {
          publicIPs: [
            { id: outboundPublicIp.id }
          ]
        }
      }
    }

    // API server access — public cluster, kubectl works from anywhere
    apiServerAccessProfile: {
      enablePrivateCluster: false
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
      // S360: Microsoft Defender for Containers — runtime threat detection
      defender: {
        logAnalyticsWorkspaceResourceId: logAnalyticsWorkspaceId
        securityMonitoring: {
          enabled: true
        }
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
          logAnalyticsWorkspaceResourceID: logAnalyticsWorkspaceId
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

    // Auto upgrade channel — patch only for stability; NodeImage keeps OS CVEs current
    autoUpgradeProfile: {
      upgradeChannel: 'patch'
      nodeOSUpgradeChannel: 'NodeImage'
    }
  }
}

// ---------------------------------------------------------------------------
// Additional node pools — compute cluster
// ---------------------------------------------------------------------------
resource sparkPool 'Microsoft.ContainerService/managedClusters/agentPools@2024-01-01' = if (clusterPurpose == 'compute') {
  parent: aksCluster
  name: 'sparkpool'
  properties: {
    // E96_v5 (96 vCPUs / 672 GiB) in prod — parameterised via sparkVmSize.
    // Regular priority (not Spot): Spark Connect driver is a long-lived process;
    // spot eviction would kill active VS Code sessions and is not recoverable.
    // Spark Operator batch jobs tolerate restarts, but the driver pod does not.
    vmSize: sparkVmSize
    count: 0
    minCount: 0
    maxCount: sparkMaxNodes
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
  }
}

resource trinoPool 'Microsoft.ContainerService/managedClusters/agentPools@2024-01-01' = if (clusterPurpose == 'compute') {
  parent: aksCluster
  name: 'trinopool'
  properties: {
    vmSize: trinoVmSize
    count: 1
    minCount: 1
    maxCount: trinoMaxNodes
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
    vmSize: workerVmSize
    count: systemNodeCount
    minCount: systemNodeCount
    maxCount: workerMaxNodes
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
// Diagnostic settings — send control plane logs to Log Analytics
// ---------------------------------------------------------------------------
resource aksDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-${clusterName}'
  scope: aksCluster
  properties: {
    workspaceId: logAnalyticsWorkspaceId
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
output clusterFqdn string = aksCluster.properties.fqdn
output oidcIssuerUrl string = aksCluster.properties.oidcIssuerProfile.issuerURL
output kubeletIdentityObjectId string = kubeletIdentity.properties.principalId
output kubeletIdentityClientId string = kubeletIdentity.properties.clientId
output logAnalyticsWorkspaceId string = logAnalyticsWorkspaceId
output controlPlanePrincipalId string = aksControlPlaneIdentity.properties.principalId
