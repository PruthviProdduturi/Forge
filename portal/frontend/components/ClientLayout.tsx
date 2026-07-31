"use client";

import { useSession } from "next-auth/react";
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
  const { data: nextAuthSession, status: nextAuthStatus } = useSession();

  // Either auth system loading
  if (isConnecting || nextAuthStatus === "loading") {
    return <ForgeLoader />;
  }

  if (noAccess) {
    return <NoAccessPage />;
  }

  // Authenticated via proxy (AKS) OR NextAuth (GitHub/Google) OR demo mode
  if (isAuthenticated || nextAuthSession) {
    return <Layout>{children}</Layout>;
  }

  return <LoginPage />;
}
