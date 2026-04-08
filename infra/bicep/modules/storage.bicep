// =============================================================================
// Forge Data Platform — Storage Module
// Provisions an ADLS Gen2 storage account with private endpoints, lifecycle
// policies, containers, and diagnostic settings.
// =============================================================================

@description('Storage account name (3-24 lowercase alphanumeric characters).')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Azure region for all resources.')
param location string

@description('Storage replication type.')
@allowed(['LRS', 'ZRS', 'GRS', 'GZRS', 'RAGRS', 'RAGZRS'])
param replicationType string = 'ZRS'

@description('Resource ID of the subnet used for private endpoints.')
param privateEndpointSubnetId string

@description('Resource ID of the Private DNS Zone for ADLS DFS endpoint.')
param privateDnsZoneDfsId string

@description('Resource ID of the Private DNS Zone for Blob endpoint.')
param privateDnsZoneBlobId string

@description('Resource ID of the Log Analytics Workspace for diagnostics.')
param logAnalyticsWorkspaceId string

@description('Resource tags to apply to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Storage Account
// ---------------------------------------------------------------------------
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-04-01' = {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_${replicationType}'
  }
  properties: {
    isHnsEnabled: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Disabled'
    defaultToOAuthAuthentication: true
    supportsHttpsTrafficOnly: true
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      ipRules: []
      virtualNetworkRules: []
    }
    encryption: {
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
        file: {
          enabled: true
          keyType: 'Account'
        }
      }
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
    }
    accessTier: 'Hot'
  }
}

// ---------------------------------------------------------------------------
// Blob Service Properties — soft delete, versioning, change feed
// ---------------------------------------------------------------------------
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-04-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    // ADLS Gen2 (HNS=true) does not support blob versioning, change feed,
    // blob soft delete, or restore policy — only container soft delete is supported.
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 90
    }
    cors: {
      corsRules: []
    }
  }
}

// ---------------------------------------------------------------------------
// Blob Containers (filesystems)
// ---------------------------------------------------------------------------
resource containerBronze 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-04-01' = {
  parent: blobService
  name: 'bronze'
  properties: {
    publicAccess: 'None'
    metadata: {
      tier: 'raw'
      description: 'Raw ingestion layer'
    }
  }
}


resource containerSilver 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-04-01' = {
  parent: blobService
  name: 'silver'
  properties: {
    publicAccess: 'None'
    metadata: {
      tier: 'curated'
      description: 'Cleaned and conformed layer'
    }
  }
}

resource containerGold 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-04-01' = {
  parent: blobService
  name: 'gold'
  properties: {
    publicAccess: 'None'
    metadata: {
      tier: 'consumption'
      description: 'Business-ready consumption layer'
    }
  }
}

resource containerSandbox 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-04-01' = {
  parent: blobService
  name: 'sandbox'
  properties: {
    publicAccess: 'None'
    metadata: {
      tier: 'experimental'
      description: 'Ephemeral exploration area'
    }
  }
}

resource containerCode 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-04-01' = {
  parent: blobService
  name: 'code'
  properties: {
    publicAccess: 'None'
    metadata: {
      tier: 'code'
      description: 'Job artifacts, scripts, forge_lib.zip, Airflow logs, and Spark Structured Streaming checkpoints (code/checkpoints/)'
    }
  }
}
// No separate checkpoints container — checkpoints live at code/checkpoints/<pipeline_id>/

// ---------------------------------------------------------------------------
// Lifecycle Management Policy
// ---------------------------------------------------------------------------
resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-04-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        // Sandbox — delete after 30 days
        {
          name: 'sandbox-cleanup'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['sandbox/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 30
                }
              }
              snapshot: {
                delete: {
                  daysAfterCreationGreaterThan: 30
                }
              }
            }
          }
        }
        // Bronze — cool at 30d, delete at 2 years
        {
          name: 'bronze-tiering'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['bronze/']
            }
            actions: {
              baseBlob: {
                tierToCool: {
                  daysAfterModificationGreaterThan: 30
                }
                delete: {
                  daysAfterModificationGreaterThan: 730
                }
              }
              snapshot: {
                tierToCool: {
                  daysAfterCreationGreaterThan: 30
                }
                delete: {
                  daysAfterCreationGreaterThan: 730
                }
              }
            }
          }
        }
        // Silver — cool at 90d, delete at 2 years
        {
          name: 'silver-tiering'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['silver/']
            }
            actions: {
              baseBlob: {
                tierToCool: {
                  daysAfterModificationGreaterThan: 90
                }
                delete: {
                  daysAfterModificationGreaterThan: 730
                }
              }
              snapshot: {
                tierToCool: {
                  daysAfterCreationGreaterThan: 90
                }
                delete: {
                  daysAfterCreationGreaterThan: 730
                }
              }
            }
          }
        }
        // Checkpoints (under code/checkpoints/) — delete after 90 days
        {
          name: 'checkpoints-cleanup'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['code/checkpoints/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 90
                }
              }
              snapshot: {
                delete: {
                  daysAfterCreationGreaterThan: 90
                }
              }
            }
          }
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Private Endpoint — DFS (ADLS Gen2)
// ---------------------------------------------------------------------------
resource pepDfs 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pep-${storageAccountName}-dfs'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'plsc-${storageAccountName}-dfs'
        properties: {
          privateLinkServiceId: storageAccount.id
          groupIds: ['dfs']
          requestMessage: 'Auto-approved private endpoint for ADLS DFS'
        }
      }
    ]
    customNetworkInterfaceName: 'nic-pep-${storageAccountName}-dfs'
  }
}

resource pepDfsDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: pepDfs
  name: 'dnsZoneGroup'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-dfs-core-windows-net'
        properties: {
          privateDnsZoneId: privateDnsZoneDfsId
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Private Endpoint — Blob
// ---------------------------------------------------------------------------
resource pepBlob 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pep-${storageAccountName}-blob'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'plsc-${storageAccountName}-blob'
        properties: {
          privateLinkServiceId: storageAccount.id
          groupIds: ['blob']
          requestMessage: 'Auto-approved private endpoint for Blob storage'
        }
      }
    ]
    customNetworkInterfaceName: 'nic-pep-${storageAccountName}-blob'
  }
}

resource pepBlobDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: pepBlob
  name: 'dnsZoneGroup'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-blob-core-windows-net'
        properties: {
          privateDnsZoneId: privateDnsZoneBlobId
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Diagnostic Settings — Storage Account level
// ---------------------------------------------------------------------------
resource storageDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-${storageAccountName}'
  scope: storageAccount
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    metrics: [
      {
        category: 'Transaction'
        enabled: true
      }
      {
        category: 'Capacity'
        enabled: true
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Diagnostic Settings — Blob Service
// ---------------------------------------------------------------------------
resource blobDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-${storageAccountName}-blob'
  scope: blobService
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'StorageRead'
        enabled: true
      }
      {
        category: 'StorageWrite'
        enabled: true
      }
      {
        category: 'StorageDelete'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'Transaction'
        enabled: true
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output dfsEndpoint string = storageAccount.properties.primaryEndpoints.dfs
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob

output containerIds object = {
  bronze: containerBronze.id
  silver: containerSilver.id
  gold: containerGold.id
  sandbox: containerSandbox.id
  code: containerCode.id
}

output privateEndpointDfsId string = pepDfs.id
output privateEndpointBlobId string = pepBlob.id
