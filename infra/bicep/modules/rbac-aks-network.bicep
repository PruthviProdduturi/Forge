// =============================================================================
// Forge Data Platform — AKS Network Contributor Role Assignment
// Grants the AKS control plane identity Network Contributor on the VNet so
// AKS can manage load balancers and NIC configurations in the user-provided
// subnet. Scoped to the platform RG (where the VNet lives).
// =============================================================================

@description('Name of the VNet to grant Network Contributor on.')
param vnetName string

@description('Principal ID of the AKS control plane managed identity.')
param controlPlanePrincipalId string

var networkContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4d97b98b-1d4f-4787-a291-c67834d212e7')

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' existing = {
  name: vnetName
}

resource networkContributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(controlPlanePrincipalId, networkContributorRoleId, vnet.id)
  scope: vnet
  properties: {
    roleDefinitionId: networkContributorRoleId
    principalId: controlPlanePrincipalId
    principalType: 'ServicePrincipal'
  }
}
