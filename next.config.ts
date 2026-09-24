import type { NextConfig } from "next";

// `.wgsl` files are loaded by vgpu's loader, which resolves their imports at build time.
type WebpackConfig = { module?: { rules?: unknown[] } };

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    rules: {
      "*.wgsl": {
        loaders: ["@vgpu/wgsl/loader-webpack"],
        as: "*.js",
      },
    },
  },
  webpack(config: WebpackConfig) {
    config.module ??= {};
    config.module.rules ??= [];
    config.module.rules.push({ test: /\.wgsl$/, loader: "@vgpu/wgsl/loader-webpack" });
    return config;
  },
};

export default nextConfig;
