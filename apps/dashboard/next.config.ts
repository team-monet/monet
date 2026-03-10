import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  transpilePackages: ["@monet/types", "@monet/db"],
  async redirects() {
    return [
      {
        source: "/admin/human-groups",
        destination: "/admin/user-groups",
        permanent: true,
      },
      {
        source: "/admin/human-groups/:path*",
        destination: "/admin/user-groups/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
