using './main.bicep'

param environment = 'dev'
param location = 'northcentralus'
param subscriptionId = 'eaa4a83d-8511-497c-b0bc-40aa5f0deae1'
param tenantId = '72f988bf-86f1-41af-91ab-2d7cd011db47'
param ownerAlias = 'prproddu'
param adminGroupObjectIds = ['<your-aks-admin-group-object-id>']
param platformAdminGroupObjectId = '<your-platform-admin-group-object-id>'
param corporateIpRange = '10.0.0.0/8'
param containerRegistryId = '/subscriptions/eaa4a83d-8511-497c-b0bc-40aa5f0deae1/resourceGroups/rg-forge-platform-prproddu-dev/providers/Microsoft.ContainerRegistry/registries/forgeacrprproddudev'
param logRetentionDays = 30
param tags = {
  environment: 'dev'
  platform: 'forge'
  managedBy: 'bicep'
  owner: 'prproddu'
}
