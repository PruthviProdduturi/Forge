import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",

  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "",
    NEXT_PUBLIC_AZURE_CLIENT_ID: process.env.NEXT_PUBLIC_AZURE_CLIENT_ID ?? "",
    NEXT_PUBLIC_AZURE_TENANT_ID: process.env.NEXT_PUBLIC_AZURE_TENANT_ID ?? "",
    NEXT_PUBLIC_AZURE_REDIRECT_URI:
      process.env.NEXT_PUBLIC_AZURE_REDIRECT_URI ?? "",
  },

  experimental: {
    optimizePackageImports: ["@azure/msal-browser"],
  },

  // webpack chunk splitting only applies to `next build` (production).
  // Turbopack handles this automatically in dev — no config needed there.
  webpack(config, { isServer }) {
    if (!isServer) {
      const splitChunks = config.optimization?.splitChunks as
        | { cacheGroups?: Record<string, unknown> }
        | false
        | undefined;
      if (splitChunks) {
        splitChunks.cacheGroups = {
          ...(splitChunks.cacheGroups ?? {}),
          msal: {
            test: /[\\/]node_modules[\\/]@azure[\\/]msal-browser[\\/]/,
            name: "msal",
            chunks: "all" as const,
            priority: 20,
          },
        };
      }
    }
    return config;
  },
};

export default nextConfig;
