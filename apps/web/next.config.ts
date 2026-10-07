import type { NextConfig } from "next";

// Static export: the public sandbox is plain files (GitHub Pages under /projects/forge-twin-builder/demo, or nginx in Docker).
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const config: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@forge/domain", "@forge/motion", "@forge/telemetry", "@forge/sdk"],
  typescript: { ignoreBuildErrors: true }, // type-checked separately by `npm run typecheck`
  productionBrowserSourceMaps: false,
};
export default config;
