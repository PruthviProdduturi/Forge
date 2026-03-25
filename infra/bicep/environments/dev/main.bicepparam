using './main.bicep'

param environment = 'dev'
param location = 'eastus2'
param subscriptionId = '<your-subscription-id>'
param tenantId = '<your-tenant-id>'
param adminGroupObjectIds = ['<your-aks-admin-group-object-id>']
param platformAdminGroupObjectId = '<your-platform-admin-group-object-id>'
param corporateIpRange = '10.0.0.0/8'
param containerRegistryId = '/subscriptions/<sub-id>/resourceGroups/rg-forge-acr-dev/providers/Microsoft.ContainerRegistry/registries/forgeacr-dev'
param logRetentionDays = 30
param tags = {
  environment: 'dev'
  platform: 'forge'
  managedBy: 'bicep'
}
