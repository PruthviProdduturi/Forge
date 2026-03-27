// =============================================================================
// Forge Data Platform — Identity Module
// Provisions workload managed identities with federated credentials (OIDC)
// and scoped RBAC assignments on storage containers and Key Vault.
// =============================================================================

@description('Target environment name (dev or prod).')
@allowed(['dev', 'prod'])
param environment string

@description('Azure region for managed identities.')
param location string

@description('OIDC issuer URL of the compute AKS cluster.')
param computeOidcIssuerUrl string

@description('OIDC issuer URL of the orchestration AKS cluster.')
param orchestrationOidcIssuerUrl string

@description('Resource ID of the storage account for RBAC scope resolution.')
param storageAccountId string

@description('Resource ID of the Key Vault. Empty string skips Key Vault role assignments.')
param keyVaultId string = ''

@description('Kubernetes namespace and service account mappings for each workload.')
param namespaces object = {
  spark: { namespace: 'spark-jobs', serviceAccountName: 'spark' }
  trino: { namespace: 'trino', serviceAccountName: 'trino' }
  airflow: { namespace: 'airflow', serviceAccountName: 'airflow' }
  dq: { namespace: 'dq', serviceAccountName: 'dq-runner' }
  portal: { namespace: 'portal', serviceAccountName: 'portal-api' }
  lineage: { namespace: 'lineage', serviceAccountName: 'purview' }
}

@description('Resource tags to apply to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Role definition resource IDs (built-in)
// ---------------------------------------------------------------------------
var storageBlobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var storageBlobDataReaderRoleId      = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
var kvSecretsUserRoleId              = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e0')

// ---------------------------------------------------------------------------
// Helper: container scope builder
// ---------------------------------------------------------------------------
var storageContainerBase = '${storageAccountId}/blobServices/default/containers'

// ---------------------------------------------------------------------------
// Existing resource references
// S360: Role assignments are scoped directly to the resource rather
// than the resource group, minimising blast radius per least-privilege.
// ---------------------------------------------------------------------------
resource storageAccountRef 'Microsoft.Storage/storageAccounts@2023-04-01' existing = {
  name: last(split(storageAccountId, '/'))
  scope: resourceGroup(split(storageAccountId, '/')[2], split(storageAccountId, '/')[4])
}

resource keyVaultRef 'Microsoft.KeyVault/vaults@2023-07-01' existing = if (keyVaultId != '') {
  name: last(split(keyVaultId, '/'))
  scope: resourceGroup(split(keyVaultId, '/')[2], split(keyVaultId, '/')[4])
}

// ---------------------------------------------------------------------------
// Managed Identity — spark
// ---------------------------------------------------------------------------
resource idSpark 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-forge-spark-${environment}'
  location: location
  tags: tags
}

resource fcSparkCompute 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: idSpark
  name: 'fc-spark-compute-${environment}'
  properties: {
    issuer: computeOidcIssuerUrl
    subject: 'system:serviceaccount:${namespaces.spark.namespace}:${namespaces.spark.serviceAccountName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

// Spark runs on the compute cluster only; no orchestration federated credential needed

// RBAC — spark: Contributor on bronze, silver, code, checkpoints
resource sparkBronzeContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idSpark.properties.principalId, storageBlobDataContributorRoleId, '${storageContainerBase}/bronze')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: idSpark.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Spark — Storage Blob Data Contributor on bronze'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/move/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/runAsSuperUser/action\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'bronze\'))'
  }
}

resource sparkSilverContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idSpark.properties.principalId, storageBlobDataContributorRoleId, '${storageContainerBase}/silver')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: idSpark.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Spark — Storage Blob Data Contributor on silver'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/move/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/runAsSuperUser/action\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'silver\'))'
  }
}

resource sparkCodeContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idSpark.properties.principalId, storageBlobDataContributorRoleId, '${storageContainerBase}/code')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: idSpark.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Spark — Storage Blob Data Contributor on code'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/move/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/runAsSuperUser/action\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'code\'))'
  }
}

resource sparkCheckpointsContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idSpark.properties.principalId, storageBlobDataContributorRoleId, '${storageContainerBase}/checkpoints')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: idSpark.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Spark — Storage Blob Data Contributor on checkpoints'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/move/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/runAsSuperUser/action\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'checkpoints\'))'
  }
}

// ---------------------------------------------------------------------------
// Managed Identity — trino
// ---------------------------------------------------------------------------
resource idTrino 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-forge-trino-${environment}'
  location: location
  tags: tags
}

resource fcTrinoCompute 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: idTrino
  name: 'fc-trino-compute-${environment}'
  properties: {
    issuer: computeOidcIssuerUrl
    subject: 'system:serviceaccount:${namespaces.trino.namespace}:${namespaces.trino.serviceAccountName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

// RBAC — trino: Reader on silver, gold
resource trinoSilverReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idTrino.properties.principalId, storageBlobDataReaderRoleId, '${storageContainerBase}/silver')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataReaderRoleId
    principalId: idTrino.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Trino — Storage Blob Data Reader on silver'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'silver\'))'
  }
}

resource trinoGoldReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idTrino.properties.principalId, storageBlobDataReaderRoleId, '${storageContainerBase}/gold')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataReaderRoleId
    principalId: idTrino.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Trino — Storage Blob Data Reader on gold'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'gold\'))'
  }
}

// ---------------------------------------------------------------------------
// Managed Identity — airflow
// ---------------------------------------------------------------------------
resource idAirflow 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-forge-airflow-${environment}'
  location: location
  tags: tags
}

resource fcAirflowCompute 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: idAirflow
  name: 'fc-airflow-compute-${environment}'
  properties: {
    issuer: computeOidcIssuerUrl
    subject: 'system:serviceaccount:${namespaces.airflow.namespace}:${namespaces.airflow.serviceAccountName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

resource fcAirflowOrchestration 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: idAirflow
  name: 'fc-airflow-orchestration-${environment}'
  properties: {
    issuer: orchestrationOidcIssuerUrl
    subject: 'system:serviceaccount:${namespaces.airflow.namespace}:${namespaces.airflow.serviceAccountName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

// RBAC — airflow: Reader on code
resource airflowCodeReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idAirflow.properties.principalId, storageBlobDataReaderRoleId, '${storageContainerBase}/code')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataReaderRoleId
    principalId: idAirflow.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Airflow — Storage Blob Data Reader on code'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'code\'))'
  }
}

// ---------------------------------------------------------------------------
// Managed Identity — dq (Data Quality)
// ---------------------------------------------------------------------------
resource idDq 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-forge-dq-${environment}'
  location: location
  tags: tags
}

resource fcDqCompute 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: idDq
  name: 'fc-dq-compute-${environment}'
  properties: {
    issuer: computeOidcIssuerUrl
    subject: 'system:serviceaccount:${namespaces.dq.namespace}:${namespaces.dq.serviceAccountName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

resource fcDqOrchestration 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: idDq
  name: 'fc-dq-orchestration-${environment}'
  properties: {
    issuer: orchestrationOidcIssuerUrl
    subject: 'system:serviceaccount:${namespaces.dq.namespace}:${namespaces.dq.serviceAccountName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

// RBAC — dq: Contributor on silver; Reader on bronze, gold
resource dqSilverContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idDq.properties.principalId, storageBlobDataContributorRoleId, '${storageContainerBase}/silver')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: idDq.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'DQ — Storage Blob Data Contributor on silver'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/move/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/runAsSuperUser/action\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'silver\'))'
  }
}

resource dqBronzeReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idDq.properties.principalId, storageBlobDataReaderRoleId, '${storageContainerBase}/bronze')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataReaderRoleId
    principalId: idDq.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'DQ — Storage Blob Data Reader on bronze'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'bronze\'))'
  }
}

resource dqGoldReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idDq.properties.principalId, storageBlobDataReaderRoleId, '${storageContainerBase}/gold')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataReaderRoleId
    principalId: idDq.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'DQ — Storage Blob Data Reader on gold'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'gold\'))'
  }
}

// ---------------------------------------------------------------------------
// Managed Identity — portal
// ---------------------------------------------------------------------------
resource idPortal 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-forge-portal-${environment}'
  location: location
  tags: tags
}

resource fcPortalCompute 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: idPortal
  name: 'fc-portal-compute-${environment}'
  properties: {
    issuer: computeOidcIssuerUrl
    subject: 'system:serviceaccount:${namespaces.portal.namespace}:${namespaces.portal.serviceAccountName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

resource fcPortalOrchestration 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: idPortal
  name: 'fc-portal-orchestration-${environment}'
  properties: {
    issuer: orchestrationOidcIssuerUrl
    subject: 'system:serviceaccount:${namespaces.portal.namespace}:${namespaces.portal.serviceAccountName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

// RBAC — portal: Reader on gold
resource portalGoldReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idPortal.properties.principalId, storageBlobDataReaderRoleId, '${storageContainerBase}/gold')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataReaderRoleId
    principalId: idPortal.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Portal — Storage Blob Data Reader on gold'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'gold\'))'
  }
}

// ---------------------------------------------------------------------------
// Managed Identity — lineage (Marquez)
// ---------------------------------------------------------------------------
resource idLineage 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-forge-lineage-${environment}'
  location: location
  tags: tags
}

resource fcLineageCompute 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: idLineage
  name: 'fc-lineage-compute-${environment}'
  properties: {
    issuer: computeOidcIssuerUrl
    subject: 'system:serviceaccount:${namespaces.lineage.namespace}:${namespaces.lineage.serviceAccountName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

resource fcLineageOrchestration 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: idLineage
  name: 'fc-lineage-orchestration-${environment}'
  properties: {
    issuer: orchestrationOidcIssuerUrl
    subject: 'system:serviceaccount:${namespaces.lineage.namespace}:${namespaces.lineage.serviceAccountName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

// RBAC — lineage: Reader on bronze, silver, gold
resource lineageBronzeReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idLineage.properties.principalId, storageBlobDataReaderRoleId, '${storageContainerBase}/bronze')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataReaderRoleId
    principalId: idLineage.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Lineage — Storage Blob Data Reader on bronze'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'bronze\'))'
  }
}

resource lineageSilverReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idLineage.properties.principalId, storageBlobDataReaderRoleId, '${storageContainerBase}/silver')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataReaderRoleId
    principalId: idLineage.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Lineage — Storage Blob Data Reader on silver'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'silver\'))'
  }
}

resource lineageGoldReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(idLineage.properties.principalId, storageBlobDataReaderRoleId, '${storageContainerBase}/gold')
  scope: storageAccountRef
  properties: {
    roleDefinitionId: storageBlobDataReaderRoleId
    principalId: idLineage.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Lineage — Storage Blob Data Reader on gold'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals \'gold\'))'
  }
}

// ---------------------------------------------------------------------------
// Key Vault role assignments — conditional on keyVaultId being provided
// All 6 workloads get Key Vault Secrets User
// ---------------------------------------------------------------------------
resource kvSparkSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (keyVaultId != '') {
  name: guid(idSpark.properties.principalId, kvSecretsUserRoleId, keyVaultId)
  scope: keyVaultRef
  properties: {
    roleDefinitionId: kvSecretsUserRoleId
    principalId: idSpark.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Spark — Key Vault Secrets User'
  }
}

resource kvTrinoSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (keyVaultId != '') {
  name: guid(idTrino.properties.principalId, kvSecretsUserRoleId, keyVaultId)
  scope: keyVaultRef
  properties: {
    roleDefinitionId: kvSecretsUserRoleId
    principalId: idTrino.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Trino — Key Vault Secrets User'
  }
}

resource kvAirflowSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (keyVaultId != '') {
  name: guid(idAirflow.properties.principalId, kvSecretsUserRoleId, keyVaultId)
  scope: keyVaultRef
  properties: {
    roleDefinitionId: kvSecretsUserRoleId
    principalId: idAirflow.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Airflow — Key Vault Secrets User'
  }
}

resource kvDqSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (keyVaultId != '') {
  name: guid(idDq.properties.principalId, kvSecretsUserRoleId, keyVaultId)
  scope: keyVaultRef
  properties: {
    roleDefinitionId: kvSecretsUserRoleId
    principalId: idDq.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'DQ — Key Vault Secrets User'
  }
}

resource kvPortalSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (keyVaultId != '') {
  name: guid(idPortal.properties.principalId, kvSecretsUserRoleId, keyVaultId)
  scope: keyVaultRef
  properties: {
    roleDefinitionId: kvSecretsUserRoleId
    principalId: idPortal.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Portal — Key Vault Secrets User'
  }
}

resource kvLineageSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (keyVaultId != '') {
  name: guid(idLineage.properties.principalId, kvSecretsUserRoleId, keyVaultId)
  scope: keyVaultRef
  properties: {
    roleDefinitionId: kvSecretsUserRoleId
    principalId: idLineage.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Lineage — Key Vault Secrets User'
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output identities object = {
  spark: {
    id: idSpark.id
    clientId: idSpark.properties.clientId
    principalId: idSpark.properties.principalId
  }
  trino: {
    id: idTrino.id
    clientId: idTrino.properties.clientId
    principalId: idTrino.properties.principalId
  }
  airflow: {
    id: idAirflow.id
    clientId: idAirflow.properties.clientId
    principalId: idAirflow.properties.principalId
  }
  dq: {
    id: idDq.id
    clientId: idDq.properties.clientId
    principalId: idDq.properties.principalId
  }
  portal: {
    id: idPortal.id
    clientId: idPortal.properties.clientId
    principalId: idPortal.properties.principalId
  }
  lineage: {
    id: idLineage.id
    clientId: idLineage.properties.clientId
    principalId: idLineage.properties.principalId
  }
}
