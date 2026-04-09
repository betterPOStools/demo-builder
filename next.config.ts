import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "mupdf"],
  devIndicators: false,
  allowedDevOrigins: ["100.96.113.106", "aarons-imac.tail0f324a.ts.net"],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
