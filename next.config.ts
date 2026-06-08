import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for Tauri production builds.
  // During `pnpm tauri dev`, devUrl points to the Next.js dev server instead.
  output: "export",
  // Disable image optimization (not available in static export mode).
  images: { unoptimized: true },
  // Add trailing slashes so Tauri's file protocol resolves paths correctly.
  trailingSlash: true,
  experimental: {
    // Prevents the dev server from loading entire packages into memory when only
    // specific exports are used. Fixes OOM crashes from lucide-react (thousands of
    // icons), framer-motion, and radix-ui bloating the module cache in dev mode.
    optimizePackageImports: ["lucide-react", "framer-motion", "radix-ui", "recharts"],
  },
};

export default nextConfig;
