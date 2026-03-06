import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@monet/types", "@monet/db"],
};

export default nextConfig;
