// Builds the unpacked extension into dist/. Load it from chrome://extensions
// with "Load unpacked"; the Release workflow zips it for download.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { context } from "esbuild";

const watch = process.argv.includes("--watch");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

rmSync("dist", { recursive: true, force: true });
cpSync("public", "dist", { recursive: true });
const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
writeFileSync("dist/manifest.json", `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

const ctx = await context({
  entryPoints: {
    background: "src/background.ts",
    "content-chatgpt": "src/content/chatgpt.ts",
    "content-claude": "src/content/claude.ts",
    popup: "src/ui/popup.ts",
    view: "src/ui/view.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome120",
  logLevel: "warning",
});

if (watch) {
  await ctx.watch();
  console.log("Watching for changes; reload the extension in chrome://extensions after each build.");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
