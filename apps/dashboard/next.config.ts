import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
