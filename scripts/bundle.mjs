// Bundles the CLI into dist/ with every dependency inlined, so the release
// tarball installs with nothing but Node.js. Runs on `npm pack` (prepack).
import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["apps/cli/src/main.ts"],
  outdir: "dist",
  bundle: true,
  // Splitting keeps node:sqlite in a lazily loaded chunk, so main.ts can check
  // the Node version and silence the SQLite warning before it loads.
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  alias: {
    "@threadbase/core": "./packages/core/src/index.ts",
    "@threadbase/importers": "./packages/importers/src/index.ts",
  },
  logLevel: "warning",
});
