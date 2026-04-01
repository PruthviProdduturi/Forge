"use client";

import { useAuth } from "../auth/useAuth";
import { Layout } from "./Layout";
import { LoginPage } from "../app/login/LoginPage";
import { ForgeLoader } from "./ForgeLoader";

function NoAccessPage() {
  return (
    <div className="no-access-container" role="alert">
      <div className="no-access-icon" aria-hidden="true">
        <i className="fas fa-ban" />
      </div>
      <h1 className="no-access-title">Access Denied</h1>
      <p className="no-access-sub">
        Your account does not have permission to access Forge. Please contact
        your platform administrator to request access.
      </p>
    </div>
  );
}

export function ClientLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isConnecting, noAccess } = useAuth();

  if (isConnecting) {
    return <ForgeLoader />;
  }

  if (noAccess) {
    return <NoAccessPage />;
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <Layout>{children}</Layout>;
}
