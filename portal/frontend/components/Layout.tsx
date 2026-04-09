"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { useTheme } from "../contexts/ThemeContext";
import { useRole } from "../hooks/useRole";
import { ForgeLogo } from "./ForgeLogo";
import { ThemeModal } from "./ThemeModal";
import { apiFetch } from "../utils/api";

interface PlatformInfo {
  env: string;
  auth_provider: string;
  platform: {
    airflow_host: string;
    trino_host: string;
    adls_account: string;
    purview_endpoint: string;
    resource_group: string;
  };
}

interface NavItem {
  href: string;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/pipelines", label: "Pipelines", icon: "fa-sitemap" },
  { href: "/datasets", label: "Datasets", icon: "fa-database" },
  { href: "/lineage", label: "Lineage", icon: "fa-share-nodes" },
  { href: "/dq", label: "Data Quality", icon: "fa-shield-halved" },
  { href: "/cost", label: "Cost", icon: "fa-coins" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout, getToken } = useAuth();
  const { primaryColor } = useTheme();
  const { role } = useRole();
  const [logoAnimating, setLogoAnimating] = useState(false);
  const [themeModalOpen, setThemeModalOpen] = useState(false);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);

  useEffect(() => {
    apiFetch<PlatformInfo>("/api/health", getToken)
      .then(setPlatformInfo)
      .catch(() => {/* non-critical */});
  }, [getToken]);

  const handleLogoClick = useCallback(() => {
    setLogoAnimating(true);
    setTimeout(() => {
      setLogoAnimating(false);
      router.push("/");
    }, 400);
  }, [router]);

  const handleRefresh = useCallback(() => {
    window.location.reload();
  }, []);

  const handleSignOut = useCallback(async () => {
    await logout();
  }, [logout]);

  const isActive = (href: string) => pathname.startsWith(href);

  void primaryColor; // used by CSS vars applied by ThemeContext

  return (
    <>
      <header className="app-header">
        {/* Left side */}
        <div className="header-left">
          <ForgeLogo
            size={36}
            animate="revolve"
            showName={true}
            onClick={handleLogoClick}
          />
          {logoAnimating && <span style={{ display: "none" }} />}

          <div className="header-divider" aria-hidden="true" />

          <nav className="top-nav" aria-label="Main navigation">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`header-btn${isActive(item.href) ? " header-btn-active" : ""}`}
                aria-current={isActive(item.href) ? "page" : undefined}
              >
                <i className={`fas ${item.icon}`} aria-hidden="true" />
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        {/* Right side */}
        <div className="header-right">
          {/* Env dropdown */}
          {platformInfo?.env && (
            <div className="header-dropdown header-dropdown-right">
              <button
                className="header-env-btn"
                type="button"
                title={`Environment: ${platformInfo.env}`}
              >
                <span style={{
                  padding: "1px 8px", borderRadius: 5, fontSize: 10, fontWeight: 800,
                  letterSpacing: "0.08em", textTransform: "uppercase",
                  background: platformInfo.env === "prod" ? "#fee2e2" : "#dcfce7",
                  color: platformInfo.env === "prod" ? "#dc2626" : "#16a34a",
                  border: `1px solid ${platformInfo.env === "prod" ? "#fca5a5" : "#86efac"}`,
                  display: "inline-flex", alignItems: "center", gap: 4,
                }}>
                  {platformInfo.env ?? "dev"}
                  <i className="fas fa-chevron-down" style={{ fontSize: 8, opacity: 0.6 }} aria-hidden="true" />
                </span>
              </button>
              <div className="header-dropdown-menu" role="menu" style={{ minWidth: 280 }}>
                <div style={{ padding: "10px 16px 6px", borderBottom: "1px solid #f1f5f9" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#94a3b8", marginBottom: 8 }}>
                    Connected Platform
                  </div>
                  {[
                    ["Environment", (platformInfo.env ?? "unknown").toUpperCase()],
                    ["Auth", "Azure AD"],
                    ["Airflow", platformInfo.platform?.airflow_host ?? "—"],
                    ["Trino", platformInfo.platform?.trino_host ?? "—"],
                    ["ADLS", platformInfo.platform?.adls_account ?? "—"],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                      <span style={{ fontSize: 11, color: "#64748b" }}>{label}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "#0f172a", fontFamily: "monospace" }}>{value}</span>
                    </div>
                  ))}
                </div>
                <Link
                  href="/settings"
                  role="menuitem"
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", fontSize: 13, color: "#374151", textDecoration: "none" }}
                >
                  <i className="fas fa-server" aria-hidden="true" />
                  Platform
                </Link>
              </div>
            </div>
          )}

          <button
            className="header-icon-btn"
            onClick={handleRefresh}
            title="Refresh"
            aria-label="Refresh page"
            type="button"
          >
            <i className="fas fa-rotate" aria-hidden="true" />
          </button>

          {/* About */}
          <Link
            href="/about"
            className={`header-icon-btn${isActive("/about") ? " header-btn-active" : ""}`}
            title="About Forge"
            aria-label="About Forge"
          >
            <i className="fas fa-circle-info" aria-hidden="true" />
          </Link>

          {/* Gear — app settings */}
          <div className="header-dropdown header-dropdown-right">
            <button
              className={`header-icon-btn${isActive("/settings") ? " header-btn-active" : ""}`}
              title="Settings"
              aria-label="Settings"
              type="button"
            >
              <i className="fas fa-gear" aria-hidden="true" />
            </button>
            <div className="header-dropdown-menu" role="menu">
              <button onClick={() => setThemeModalOpen(true)} role="menuitem" type="button">
                <i className="fas fa-palette" aria-hidden="true" />
                Themes
              </button>
              <div className="header-dropdown-divider" />
              <Link href="/settings" role="menuitem"
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", fontSize: 13, color: "#374151", textDecoration: "none" }}>
                <i className="fas fa-server" aria-hidden="true" />
                Platform
              </Link>
            </div>
          </div>

          {/* User avatar — profile + sign out */}
          <div className="header-dropdown header-dropdown-right">
            <button
              className="user-avatar-btn"
              aria-label={`User menu — ${user?.name ?? "User"}`}
              type="button"
            >
              {user?.initials ?? "??"}
            </button>
            <div className="header-dropdown-menu user-dropdown-menu" role="menu">
              <div className="user-dropdown-header">
                <div className="user-dropdown-name">{user?.name ?? "Unknown User"}</div>
                {user?.email && <div className="user-dropdown-email">{user.email}</div>}
                {role && (
                  <div className="role-badge">
                    <i className="fas fa-shield-halved" aria-hidden="true" />
                    {role}
                  </div>
                )}
              </div>
              <div className="header-dropdown-divider" />
              <button onClick={handleSignOut} role="menuitem" type="button">
                <i className="fas fa-right-from-bracket" aria-hidden="true" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main>{children}</main>

      {themeModalOpen && (
        <ThemeModal onClose={() => setThemeModalOpen(false)} />
      )}
    </>
  );
}
