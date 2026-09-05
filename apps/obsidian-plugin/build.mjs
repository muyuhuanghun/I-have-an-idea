import { build } from "esbuild";
import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readPhase1SourceMeta, repositoryRoot, writeBundleMeta } from "../../tools/phase1-build-meta.mjs";

const source = await readPhase1SourceMeta();
const reportSchemaJson = await readFile(
  resolve(repositoryRoot, "docs/schemas/smoke-report-v1.schema.json"),
  "utf8"
);
const pluginSnapshotReportSchemaJson = await readFile(
  resolve(repositoryRoot, "docs/schemas/p0-plugin-snapshot-report-v1.schema.json"),
  "utf8"
);
const runtimeLimitsJson = await readFile(
  resolve(repositoryRoot, "docs/contracts/p0-runtime-limits-v1.json"),
  "utf8"
);
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: ["obsidian", "node:*"],
  outfile: "dist/main.js",
  sourcemap: false,
  minify: true,
  define: {
    __VECTOR_MANIFEST_JSON__: JSON.stringify(source.vectorManifestJson),
    __VECTORS_JSON__: JSON.stringify(source.vectorsJson),
    __SMOKE_REPORT_SCHEMA_JSON__: JSON.stringify(reportSchemaJson),
    __PLUGIN_SNAPSHOT_REPORT_SCHEMA_JSON__: JSON.stringify(pluginSnapshotReportSchemaJson),
    __P0_RUNTIME_LIMITS_JSON__: JSON.stringify(runtimeLimitsJson)
  },
  logLevel: "info"
});

const bundleText = await readFile("dist/main.js", "utf8");
for (const forbidden of ["NodeRestoreTarget", "restoreSnapshotV1", "p0-restore"]) {
  if (bundleText.includes(forbidden)) {
    throw new Error(`Phase 5-B plugin bundle contains forbidden restore surface: ${forbidden}`);
  }
}

await copyFile("manifest.json", "dist/manifest.json");
await writeBundleMeta({
  bundlePath: "dist/main.js",
  outputPath: "dist/build-meta.json",
  appKind: "obsidian-plugin"
});
