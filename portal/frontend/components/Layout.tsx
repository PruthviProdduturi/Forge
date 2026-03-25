"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { useTheme } from "../contexts/ThemeContext";
import { useRole } from "../hooks/useRole";
import { SettingsModal } from "./SettingsModal";
import { ForgeLogo } from "./ForgeLogo";

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
  const { user, logout } = useAuth();
  const { primaryColor } = useTheme();
  const { role } = useRole();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logoAnimating, setLogoAnimating] = useState(false);

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
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </>
  );
}
