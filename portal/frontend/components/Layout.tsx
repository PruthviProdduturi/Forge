"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { useTheme } from "../contexts/ThemeContext";
import { useRole } from "../hooks/useRole";
import { SettingsModal } from "./SettingsModal";
import { ForgeLogo } from "./ForgeLogo";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logoAnimating, setLogoAnimating] = useState(false);
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
    router.refresh();
  }, [router]);

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

          {platformInfo && (
            <span style={{
              padding: "2px 10px", borderRadius: 6, fontSize: 11, fontWeight: 800,
              letterSpacing: "0.08em", textTransform: "uppercase",
              background: platformInfo.env === "prod" ? "#fee2e2" : "#dcfce7",
              color: platformInfo.env === "prod" ? "#dc2626" : "#16a34a",
              border: `1px solid ${platformInfo.env === "prod" ? "#fca5a5" : "#86efac"}`,
              userSelect: "none",
            }}>
              {platformInfo.env}
            </span>
          )}

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
          <Link
            href="/about"
            className={`header-icon-btn${isActive("/about") ? " header-btn-active" : ""}`}
            title="About Forge"
            aria-label="About Forge"
          >
            <i className="fas fa-circle-question" aria-hidden="true" />
          </Link>

          <button
            className="header-icon-btn"
            onClick={handleRefresh}
            title="Refresh"
            aria-label="Refresh page"
            type="button"
          >
            <i className="fas fa-rotate" aria-hidden="true" />
          </button>

          {/* Settings dropdown */}
          <div className="header-dropdown header-dropdown-right">
            <button
              className="header-icon-btn"
              title="Settings"
              aria-label="Settings"
              type="button"
            >
              <i className="fas fa-gear" aria-hidden="true" />
            </button>
            <div className="header-dropdown-menu" role="menu">
              <button
                onClick={() => setSettingsOpen(true)}
                role="menuitem"
                type="button"
              >
                <i className="fas fa-palette" aria-hidden="true" />
                Themes
              </button>
            </div>
          </div>

          {/* User dropdown */}
          <div className="header-dropdown header-dropdown-right">
            <button
              className="user-avatar-btn"
              aria-label={`User menu — ${user?.name ?? "User"}`}
              type="button"
            >
              {user?.initials ?? "??"}
            </button>
            <div
              className="header-dropdown-menu user-dropdown-menu"
              role="menu"
            >
              <div className="user-dropdown-header">
                <div className="user-dropdown-name">
                  {user?.name ?? "Unknown User"}
                </div>
                {user?.email && (
                  <div className="user-dropdown-email">{user.email}</div>
                )}
                {role && (
                  <div className="role-badge">
                    <i className="fas fa-shield-halved" aria-hidden="true" />
                    {role}
                  </div>
                )}
              </div>
              <div className="header-dropdown-divider" />
              <button
                onClick={handleSignOut}
                role="menuitem"
                type="button"
              >
                <i className="fas fa-right-from-bracket" aria-hidden="true" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main>{children}</main>

      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} platformInfo={platformInfo} />
      )}
    </>
  );
}
