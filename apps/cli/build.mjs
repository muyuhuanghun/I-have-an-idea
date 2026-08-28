import { build } from "esbuild";
import { writeBundleMeta } from "../../tools/phase1-build-meta.mjs";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: "dist/main.js",
  sourcemap: false,
  minify: true,
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info"
});

await writeBundleMeta({
  bundlePath: "dist/main.js",
  outputPath: "dist/build-meta.json",
  appKind: "node-cli"
});
