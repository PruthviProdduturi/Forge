// =============================================================================
// Forge Data Platform — Log Analytics Workspace Module
// Standalone module so the workspace can be deployed before AKS, which
// requires the workspace to exist during its OMS addon preflight validation.
// =============================================================================

@description('Name of the Log Analytics workspace.')
param lawName string

@description('Azure region for all resources.')
param location string

@description('Number of days to retain Log Analytics data. S360 LM requires minimum 90 days.')
@minValue(90)
@maxValue(730)
param logRetentionDays int = 90

@description('Resource tags to apply to all resources.')
param tags object = {}

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

output id string = law.id
