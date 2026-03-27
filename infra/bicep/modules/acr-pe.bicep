// =============================================================================
// Forge Data Platform — ACR Private Endpoint Module
// Attaches an existing ACR (created by shared/main.bicep) to a VNet via a
// private endpoint. The ACR itself is not created here.
// =============================================================================

@description('Resource ID of the existing ACR to attach.')
param acrResourceId string

@description('Name to use for the private endpoint resource.')
param privateEndpointName string

@description('Azure region.')
param location string

@description('Subnet resource ID for the private endpoint NIC.')
param privateEndpointSubnetId string

@description('Resource ID of the privatelink.azurecr.io private DNS zone.')
param privateDnsZoneAcrId string

@description('Resource tags to apply to all resources.')
param tags object = {}

resource acrPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: privateEndpointName
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'plsc-acr'
        properties: {
          privateLinkServiceId: acrResourceId
          groupIds: ['registry']
        }
      }
    ]
    customNetworkInterfaceName: 'nic-${privateEndpointName}'
  }
}

resource acrDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
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

output privateEndpointId string = acrPrivateEndpoint.id
