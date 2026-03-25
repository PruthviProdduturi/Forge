using './main.bicep'

param environment = 'prod'
param location = 'eastus2'
param subscriptionId = '<your-subscription-id>'
param tenantId = '<your-tenant-id>'
param adminGroupObjectIds = ['<your-aks-admin-group-object-id>']
param platformAdminGroupObjectId = '<your-platform-admin-group-object-id>'
param corporateIpRange = '10.0.0.0/8'
param containerRegistryId = '/subscriptions/<sub-id>/resourceGroups/rg-forge-acr-prod/providers/Microsoft.ContainerRegistry/registries/forgeacr-prod'
param logRetentionDays = 90
param tags = {
  environment: 'prod'
  platform: 'forge'
  managedBy: 'bicep'
}
