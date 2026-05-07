import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    // Several lib/ modules read runtime files (/data/litellm/spend.jsonl,
    // /data/copilot/...) via env-var-derived paths. NFT can't statically
    // resolve those, so it conservatively traces the whole project and
    // flags next.config.ts as an "unexpected file". The standalone bundle
    // is fine; the warning is noise.
    ignoreIssue: [
      { title: "Encountered unexpected file in NFT list", path: "**" },
    ],
  },
};

export default nextConfig;
