"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { API_BASE } from "../config";
import { generateGradients, hexToRGB } from "../utils/colorUtils";

const DEFAULT_THEME_COLOR = "#1e3a5f";
const STORAGE_KEY = "forge-theme-color";

interface ThemeContextValue {
  primaryColor: string;
  setPrimaryColor: (color: string) => void;
  saveTheme: (color: string) => Promise<void>;
  isLoading: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

function applyThemeColor(color: string): void {
  if (typeof document === "undefined") return;

  const gradients = generateGradients(color);
  const primaryRGB = hexToRGB(gradients.base);
  const secondaryRGB = hexToRGB(gradients.light);
  const accentRGB = hexToRGB(gradients.lighter);
  const darkRGB = hexToRGB(gradients.dark);

  const root = document.documentElement;
  root.style.setProperty("--forge-primary", gradients.base);
  root.style.setProperty("--forge-secondary", gradients.light);
  root.style.setProperty("--forge-accent", gradients.lighter);
  root.style.setProperty("--forge-dark", gradients.dark);
  root.style.setProperty("--forge-light", gradients.lighter);
  root.style.setProperty(
    "--forge-primary-rgb",
    `${primaryRGB.r}, ${primaryRGB.g}, ${primaryRGB.b}`
  );
  root.style.setProperty(
    "--forge-secondary-rgb",
    `${secondaryRGB.r}, ${secondaryRGB.g}, ${secondaryRGB.b}`
  );
  root.style.setProperty(
    "--forge-accent-rgb",
    `${accentRGB.r}, ${accentRGB.g}, ${accentRGB.b}`
  );
  root.style.setProperty(
    "--forge-dark-rgb",
    `${darkRGB.r}, ${darkRGB.g}, ${darkRGB.b}`
  );

  // Compatibility aliases
  root.style.setProperty("--theme-primary", gradients.base);
  root.style.setProperty("--theme-light", gradients.lighter);
  root.style.setProperty("--theme-dark", gradients.dark);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [primaryColor, setPrimaryColorState] = useState<string>(
    DEFAULT_THEME_COLOR
  );
  const [isLoading, setIsLoading] = useState(true);

  const setPrimaryColor = useCallback((color: string) => {
    setPrimaryColorState(color);
    applyThemeColor(color);
    try {
      localStorage.setItem(STORAGE_KEY, color);
    } catch {
      // ignore
    }
  }, []);

  const saveTheme = useCallback(
    async (color: string): Promise<void> => {
      setPrimaryColor(color);
      try {
        const localToken = localStorage.getItem("forge_local_token");
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (localToken) {
          headers["Authorization"] = `Bearer ${localToken}`;
        }
        await fetch(`${API_BASE}/api/v1/theme`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ primary_color: color }),
        });
      } catch {
        // Fail gracefully — local preference is already saved
      }
    },
    [setPrimaryColor]
  );

  // Load theme on mount
  useEffect(() => {
    const loadTheme = async () => {
      // Check localStorage first for instant paint
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setPrimaryColorState(stored);
        applyThemeColor(stored);
        setIsLoading(false);
        // Still try API in background
        try {
          const res = await fetch(`${API_BASE}/api/v1/theme`);
          if (res.ok) {
            const data = (await res.json()) as { primary_color?: string };
            if (data.primary_color && data.primary_color !== stored) {
              setPrimaryColor(data.primary_color);
            }
          }
        } catch {
          // Fail gracefully
        }
        return;
      }

      // No local value — try API
      try {
        const res = await fetch(`${API_BASE}/api/v1/theme`);
        if (res.ok) {
          const data = (await res.json()) as { primary_color?: string };
          const color = data.primary_color || DEFAULT_THEME_COLOR;
          setPrimaryColor(color);
        } else {
          applyThemeColor(DEFAULT_THEME_COLOR);
        }
      } catch {
        applyThemeColor(DEFAULT_THEME_COLOR);
      } finally {
        setIsLoading(false);
      }
    };

    loadTheme();
  }, [setPrimaryColor]);

  return (
    <ThemeContext.Provider value={{ primaryColor, setPrimaryColor, saveTheme, isLoading }}>
      {children}
    </ThemeContext.Provider>
  );
}
