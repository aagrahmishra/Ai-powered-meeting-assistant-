import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  serverExternalPackages: ['@inngest/agent-kit', 'inngest'],
  async redirects() {
    return [
      {
        source: "/",
        destination: "/meetings",
        permanent: false,
      },
    ];
  },
};
export default nextConfig;
