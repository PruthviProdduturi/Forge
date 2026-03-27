// =============================================================================
// ACR Pull Role Assignment
// Grants AcrPull to a kubelet identity on the shared registry.
// Scoped to the ACR resource group (cross-RG from AKS modules).
// =============================================================================

@description('Name of the container registry.')
param registryName string

@description('Principal ID of the kubelet identity to grant AcrPull.')
param principalId string

var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(principalId, acrPullRoleId, acr.id)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: 'AKS kubelet identity — AcrPull on shared registry'
  }
}
