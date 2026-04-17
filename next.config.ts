import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "mupdf"],
  devIndicators: false,
  allowedDevOrigins: ["100.73.220.32", "aarons-imac-1.tail0f324a.ts.net"],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
