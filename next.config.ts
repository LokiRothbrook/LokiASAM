import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for Tauri production builds.
  // During `pnpm tauri dev`, devUrl points to the Next.js dev server instead.
  output: "export",
  // Disable image optimization (not available in static export mode).
  images: { unoptimized: true },
  // Add trailing slashes so Tauri's file protocol resolves paths correctly.
  trailingSlash: true,
};

export default nextConfig;
