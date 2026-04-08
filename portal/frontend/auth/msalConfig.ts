import { Configuration, PublicClientApplication } from "@azure/msal-browser";

const apiScope = process.env.NEXT_PUBLIC_AZURE_API_SCOPE;

export const loginRequest = {
  scopes: apiScope ? [apiScope] : ["User.Read"],
};

let _instance: PublicClientApplication | null = null;
let _initPromise: Promise<void> | null = null;

export function configureMsal(clientId: string, tenantId = "common"): void {
  if (_instance) return;

  const msalConfig: Configuration = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      redirectUri:
        process.env.NEXT_PUBLIC_AZURE_REDIRECT_URI || window.location.origin,
      postLogoutRedirectUri:
        process.env.NEXT_PUBLIC_AZURE_REDIRECT_URI || window.location.origin,
    },
    cache: {
      cacheLocation: "sessionStorage",
    },
  };

  _instance = new PublicClientApplication(msalConfig);
  _initPromise = _instance.initialize();
}

export function getMsalInstance(): PublicClientApplication {
  if (!_instance) {
    throw new Error(
      "MSAL has not been configured. Call configureMsal() first."
    );
  }
  return _instance;
}

export async function ensureMsalInitialized(): Promise<void> {
  if (!_instance || !_initPromise) {
    throw new Error(
      "MSAL has not been configured. Call configureMsal() first."
    );
  }
  await _initPromise;
}

// Auto-init from env vars at module load if present
if (
  typeof window !== "undefined" &&
  process.env.NEXT_PUBLIC_AZURE_CLIENT_ID &&
  process.env.NEXT_PUBLIC_AZURE_TENANT_ID
) {
  configureMsal(
    process.env.NEXT_PUBLIC_AZURE_CLIENT_ID,
    process.env.NEXT_PUBLIC_AZURE_TENANT_ID
  );
}
