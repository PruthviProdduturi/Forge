// =============================================================================
// Forge Data Platform — Networking Module
// Provisions VNet, NSGs, subnets, Azure Bastion, and Private DNS Zones.
// =============================================================================

@description('Target environment name (dev or prod).')
@allowed(['dev', 'prod'])
param environment string

@description('Azure region for all resources.')
param location string

@description('Resource tags to apply to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Address space — dev uses 10.x.x.x, prod uses 10.1x.x.x
// ---------------------------------------------------------------------------
var addressPrefixes = environment == 'dev' ? {
  vnet:             '10.0.0.0/12'
  compute:          '10.1.0.0/16'
  orchestration:    '10.2.0.0/16'
  privateEndpoints: '10.3.0.0/24'
  postgres:         '10.4.0.0/24'
} : {
  vnet:             '10.16.0.0/12'
  compute:          '10.17.0.0/16'
  orchestration:    '10.18.0.0/16'
  privateEndpoints: '10.19.0.0/24'
  postgres:         '10.20.0.0/24'
}

// ---------------------------------------------------------------------------
// Pod overlay CIDRs — fixed regardless of environment.
// Azure CNI Overlay assigns pod IPs from these ranges. They do NOT overlap
// with the VNet address space and are NOT included in the 'VirtualNetwork'
// NSG service tag, so explicit inbound rules are required for cross-node
// pod-to-pod traffic and pod-to-service traffic across clusters.
// Defined in aks.bicep: compute=10.100.0.0/16, orchestration=10.101.0.0/16
// ---------------------------------------------------------------------------
var computePodCidr = '10.100.0.0/16'
var orchPodCidr = '10.101.0.0/16'

// ---------------------------------------------------------------------------
// Platform Log Analytics Workspace — NSG and network diagnostics
// S360: Network activity audit trail. All NSGs send diagnostic logs here.
// ---------------------------------------------------------------------------
resource platformLaw 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'law-forge-platform-${environment}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 90
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: 'Disabled'
  }
}

// ---------------------------------------------------------------------------
// NSG — Compute Subnet (AKS compute cluster nodes)
//
// Security model: AKS manages its own NIC-level NSG (aks-agentpool-*-nsg) in
// the node resource group. That NSG has NRMS rules that block all Internet
// inbound traffic. This subnet NSG provides additional explicit allows for
// known traffic patterns — no deny-all at the end (the implicit rule at 65500
// handles anything not matched, and NRMS handles Internet blocking at the NIC).
//
// Removing DenyAllOtherInbound/DenyAllOtherOutbound from AKS subnets is
// intentional: Azure CNI Overlay pod overlay IPs (10.100.x.x) are outside
// the VNet address space. A subnet-level deny-all requires adding workaround
// rules for every pod CIDR combination and fights against AKS networking.
// ---------------------------------------------------------------------------
resource nsgCompute 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: 'nsg-forge-compute-${environment}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowAKSControlPlaneInbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'AzureCloud'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRanges: ['443', '10250']
        }
      }
      {
        name: 'AllowIntraSubnetInbound'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: addressPrefixes.compute
          sourcePortRange: '*'
          destinationAddressPrefix: addressPrefixes.compute
          destinationPortRange: '*'
        }
      }
      {
        // Azure CNI Overlay: pod IPs (10.100.x.x) are outside the VNet address
        // space. Explicit allow ensures cross-node pod traffic and cross-cluster
        // pod traffic (e.g., portal → Trino) are permitted at the subnet level.
        name: 'AllowComputePodOverlayInbound'
        properties: {
          priority: 115
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: computePodCidr
          sourcePortRange: '*'
          destinationAddressPrefix: addressPrefixes.compute
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowOrchestrationToCompute'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: addressPrefixes.orchestration
          sourcePortRange: '*'
          destinationAddressPrefix: addressPrefixes.compute
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowOrchPodToCompute'
        properties: {
          priority: 125
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: orchPodCidr
          sourcePortRange: '*'
          destinationAddressPrefix: addressPrefixes.compute
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowAzureLoadBalancerInbound'
        properties: {
          priority: 130
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'AzureLoadBalancer'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowVNetOutbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '*'
        }
      }
      {
        // Azure CNI Overlay: allow outbound from pod overlay IPs so cross-node
        // pod traffic (source IP = pod IP, not node IP) is not blocked.
        name: 'AllowComputePodOverlayOutbound'
        properties: {
          priority: 105
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: computePodCidr
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowAzureCloudOutbound'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureCloud'
          destinationPortRange: '443'
        }
      }
      {
        name: 'AllowAzureMonitorOutbound'
        properties: {
          priority: 120
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureMonitor'
          destinationPortRange: '443'
        }
      }
      {
        name: 'AllowInternetOutbound'
        properties: {
          priority: 130
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: 'Internet'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// NSG — Orchestration Subnet (AKS orchestration cluster nodes)
//
// Security model: same as compute NSG — AKS manages its own NIC-level NSG
// (aks-agentpool-*-nsg) with NRMS rules that block Internet inbound.
// No deny-all at the end; implicit 65500 + NRMS handle anything not matched.
// ---------------------------------------------------------------------------
resource nsgOrchestration 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: 'nsg-forge-orchestration-${environment}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowAKSControlPlaneInbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'AzureCloud'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRanges: ['443', '10250']
        }
      }
      {
        name: 'AllowIntraSubnetInbound'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: addressPrefixes.orchestration
          sourcePortRange: '*'
          destinationAddressPrefix: addressPrefixes.orchestration
          destinationPortRange: '*'
        }
      }
      {
        // Required for Azure CNI Overlay: pod IPs (10.101.x.x) are outside the
        // VNet address space and not covered by AllowIntraSubnetInbound.
        name: 'AllowOrchPodOverlayInbound'
        properties: {
          priority: 115
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: orchPodCidr
          sourcePortRange: '*'
          destinationAddressPrefix: addressPrefixes.orchestration
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowComputeToOrchestration'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: addressPrefixes.compute
          sourcePortRange: '*'
          destinationAddressPrefix: addressPrefixes.orchestration
          destinationPortRange: '*'
        }
      }
      {
        // Allows compute cluster pods to reach orchestration cluster services
        // (e.g. Airflow API). Compute pod IPs (10.100.x.x) are not covered
        // by AllowComputeToOrchestration which only allows node IPs.
        name: 'AllowComputePodToOrch'
        properties: {
          priority: 125
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: computePodCidr
          sourcePortRange: '*'
          destinationAddressPrefix: addressPrefixes.orchestration
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowAzureLoadBalancerInbound'
        properties: {
          priority: 130
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'AzureLoadBalancer'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowVNetOutbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '*'
        }
      }
      {
        // Azure CNI Overlay: allow outbound from pod overlay IPs so cross-node
        // pod traffic (source IP = pod IP, not node IP) is not blocked.
        name: 'AllowOrchPodOverlayOutbound'
        properties: {
          priority: 105
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: orchPodCidr
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowAzureCloudOutbound'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureCloud'
          destinationPortRange: '443'
        }
      }
      {
        name: 'AllowAzureMonitorOutbound'
        properties: {
          priority: 120
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureMonitor'
          destinationPortRange: '443'
        }
      }
      {
        // Required for AKS node bootstrapping: nodes must reach Ubuntu/Kubernetes
        // apt repos and pull container images during initial provisioning.
        // Long-term: replace with Azure Firewall + UDR and allowlist specific FQDNs.
        name: 'AllowInternetOutbound'
        properties: {
          priority: 130
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: 'Internet'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// NSG — Private Endpoints Subnet
// ---------------------------------------------------------------------------
resource nsgPrivateEndpoints 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: 'nsg-forge-private-endpoints-${environment}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowVNetInbound443'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'AllowVNetInbound1433'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '1433'
        }
      }
      {
        name: 'AllowVNetInbound5432'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '5432'
        }
      }
      {
        name: 'DenyAllOtherInbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowVNetOutbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '*'
        }
      }
      {
        name: 'DenyAllOtherOutbound'
        properties: {
          priority: 4096
          direction: 'Outbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}



// ---------------------------------------------------------------------------
// NSG — Postgres Subnet (PostgreSQL Flexible Server VNet integration)
// Allows inbound 5432 from compute subnet only (HMS pods).
// ---------------------------------------------------------------------------
resource nsgPostgres 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: 'nsg-forge-postgres-${environment}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowHMSInbound5432'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: addressPrefixes.compute
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '5432'
        }
      }
      {
        name: 'DenyAllOtherInbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}


// ---------------------------------------------------------------------------
// Route Tables — stubs for future Azure Firewall UDR migration.
//
// NOT attached to subnets until Azure Firewall is deployed. Attaching an
// empty UDR to an AKS subnet breaks Azure CNI Overlay cross-node pod routing
// because the UDR overrides the pod-CIDR routes Azure programs in the VNet
// fabric, causing all cross-node pod traffic (including DNS) to be dropped.
//
// Migration path when Firewall is ready:
//   1. Add route: 0.0.0.0/0 → Firewall private IP (NextHopType: VirtualAppliance)
//   2. Re-attach route tables to subnets (restore the routeTable block below)
//   3. Set AKS outboundType: 'userDefinedRouting' on both clusters
//   4. Remove the AllowInternetOutbound NSG rules (no longer needed)
// ---------------------------------------------------------------------------
resource rtCompute 'Microsoft.Network/routeTables@2023-11-01' = {
  name: 'rt-forge-compute-${environment}'
  location: location
  tags: tags
  properties: {
    disableBgpRoutePropagation: false
  }
}

resource rtOrchestration 'Microsoft.Network/routeTables@2023-11-01' = {
  name: 'rt-forge-orchestration-${environment}'
  location: location
  tags: tags
  properties: {
    disableBgpRoutePropagation: false
  }
}

// ---------------------------------------------------------------------------
// Virtual Network with all subnets
// ---------------------------------------------------------------------------
resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: 'vnet-forge-${environment}'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [addressPrefixes.vnet]
    }
    subnets: [
      {
        name: 'snet-forge-compute-${environment}'
        properties: {
          addressPrefix: addressPrefixes.compute
          networkSecurityGroup: {
            id: nsgCompute.id
          }
          // routeTable intentionally omitted — see Route Tables comment above.
          // Re-attach rtCompute here when Azure Firewall is deployed.
          privateEndpointNetworkPolicies: 'Enabled'
          privateLinkServiceNetworkPolicies: 'Enabled'
        }
      }
      {
        name: 'snet-forge-orchestration-${environment}'
        properties: {
          addressPrefix: addressPrefixes.orchestration
          networkSecurityGroup: {
            id: nsgOrchestration.id
          }
          // routeTable intentionally omitted — see Route Tables comment above.
          // Re-attach rtOrchestration here when Azure Firewall is deployed.
          privateEndpointNetworkPolicies: 'Enabled'
          privateLinkServiceNetworkPolicies: 'Enabled'
        }
      }
      {
        name: 'snet-forge-private-endpoints-${environment}'
        properties: {
          addressPrefix: addressPrefixes.privateEndpoints
          networkSecurityGroup: {
            id: nsgPrivateEndpoints.id
          }
          privateEndpointNetworkPolicies: 'Disabled'
          privateLinkServiceNetworkPolicies: 'Enabled'
        }
      }
      {
        name: 'snet-forge-postgres-${environment}'
        properties: {
          addressPrefix: addressPrefixes.postgres
          networkSecurityGroup: {
            id: nsgPostgres.id
          }
          delegations: [
            {
              name: 'postgres-delegation'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
          privateEndpointNetworkPolicies: 'Enabled'
          privateLinkServiceNetworkPolicies: 'Enabled'
        }
      }
    ]
  }
}


// ---------------------------------------------------------------------------
// Private DNS Zones
// ---------------------------------------------------------------------------
resource dnsZoneDfs 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  #disable-next-line no-hardcoded-env-urls
  name: 'privatelink.dfs.core.windows.net'
  location: 'global'
  tags: tags
}

resource dnsZoneBlob 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  #disable-next-line no-hardcoded-env-urls
  name: 'privatelink.blob.core.windows.net'
  location: 'global'
  tags: tags
}

resource dnsZoneVault 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
  tags: tags
}

resource dnsZoneAcr 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.azurecr.io'
  location: 'global'
  tags: tags
}

resource dnsZonePostgres 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource dnsZoneMonitor 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.monitor.azure.com'
  location: 'global'
  tags: tags
}

resource dnsZoneOms 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.oms.opinsights.azure.com'
  location: 'global'
  tags: tags
}

resource dnsZoneOds 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.ods.opinsights.azure.com'
  location: 'global'
  tags: tags
}

resource dnsZoneAgentsvc 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.agentsvc.azure-automation.net'
  location: 'global'
  tags: tags
}


// ---------------------------------------------------------------------------
// Private DNS Zone — VNet Links
// ---------------------------------------------------------------------------
resource vnetLinkDfs 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dnsZoneDfs
  name: 'link-dfs-${environment}'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource vnetLinkBlob 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dnsZoneBlob
  name: 'link-blob-${environment}'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource vnetLinkVault 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dnsZoneVault
  name: 'link-vault-${environment}'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource vnetLinkAcr 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dnsZoneAcr
  name: 'link-acr-${environment}'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource vnetLinkPostgres 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dnsZonePostgres
  name: 'link-postgres-${environment}'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource vnetLinkMonitor 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dnsZoneMonitor
  name: 'link-monitor-${environment}'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource vnetLinkOms 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dnsZoneOms
  name: 'link-oms-${environment}'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource vnetLinkOds 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dnsZoneOds
  name: 'link-ods-${environment}'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

resource vnetLinkAgentsvc 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dnsZoneAgentsvc
  name: 'link-agentsvc-${environment}'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}


// ---------------------------------------------------------------------------
// NSG Diagnostic Settings — S360: audit all allow/deny decisions
// Note: NSG Flow Logs (per-connection traffic metadata, S360 NS2.1.1) are not
// configured here — they require a Storage Account and optionally Traffic
// Analytics. Add post-deploy via:
//   az network watcher flow-log create --nsg <nsg-id> --storage-account <id>
// ---------------------------------------------------------------------------
resource nsgComputeDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-nsg-compute-${environment}'
  scope: nsgCompute
  properties: {
    workspaceId: platformLaw.id
    logs: [
      {
        category: 'NetworkSecurityGroupEvent'
        enabled: true
      }
      {
        category: 'NetworkSecurityGroupRuleCounter'
        enabled: true
      }
    ]
  }
}

resource nsgOrchestrationDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-nsg-orchestration-${environment}'
  scope: nsgOrchestration
  properties: {
    workspaceId: platformLaw.id
    logs: [
      {
        category: 'NetworkSecurityGroupEvent'
        enabled: true
      }
      {
        category: 'NetworkSecurityGroupRuleCounter'
        enabled: true
      }
    ]
  }
}

resource nsgPrivateEndpointsDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-nsg-pe-${environment}'
  scope: nsgPrivateEndpoints
  properties: {
    workspaceId: platformLaw.id
    logs: [
      {
        category: 'NetworkSecurityGroupEvent'
        enabled: true
      }
      {
        category: 'NetworkSecurityGroupRuleCounter'
        enabled: true
      }
    ]
  }
}



// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output vnetId string = vnet.id
output vnetName string = vnet.name

output subnetIds object = {
  compute: '${vnet.id}/subnets/snet-forge-compute-${environment}'
  orchestration: '${vnet.id}/subnets/snet-forge-orchestration-${environment}'
  privateEndpoints: '${vnet.id}/subnets/snet-forge-private-endpoints-${environment}'
  postgres: '${vnet.id}/subnets/snet-forge-postgres-${environment}'
}

output privateDnsZoneIds object = {
  dfs: dnsZoneDfs.id
  blob: dnsZoneBlob.id
  vault: dnsZoneVault.id
  acr: dnsZoneAcr.id
  postgres: dnsZonePostgres.id
  monitor: dnsZoneMonitor.id
  oms: dnsZoneOms.id
  ods: dnsZoneOds.id
  agentsvc: dnsZoneAgentsvc.id
}

output platformLogAnalyticsWorkspaceId string = platformLaw.id

resource nsgPostgresDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-nsg-postgres-${environment}'
  scope: nsgPostgres
  properties: {
    workspaceId: platformLaw.id
    logs: [
      {
        category: 'NetworkSecurityGroupEvent'
        enabled: true
      }
      {
        category: 'NetworkSecurityGroupRuleCounter'
        enabled: true
      }
    ]
  }
}
