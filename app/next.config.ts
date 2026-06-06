import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      { source: "/skills", destination: "/library/skills", permanent: true },
      { source: "/agent-types", destination: "/library/agent-types", permanent: true },
      { source: "/agent-types/:specialty", destination: "/library/agent-types/:specialty", permanent: true },
    ];
  },
};

export default nextConfig;
