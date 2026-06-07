import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      // Library migrations (permanent)
      { source: "/skills", destination: "/library/skills", permanent: true },
      { source: "/agent-types", destination: "/library/agent-types", permanent: true },
      { source: "/agent-types/:specialty", destination: "/library/agent-types/:specialty", permanent: true },
      // Prime-scoped migrations — redirect to home (user picks prime first)
      { source: "/brain", destination: "/", permanent: false },
      { source: "/work", destination: "/", permanent: false },
      { source: "/projects", destination: "/", permanent: false },
      { source: "/processes", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
