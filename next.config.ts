import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Expose only NEXT_PUBLIC_ vars to the browser; server-side secrets stay server-side
  experimental: {},
};

export default nextConfig;
