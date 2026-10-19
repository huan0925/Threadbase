#!/usr/bin/env node
// Keep this file free of static imports: it must run on old Node versions long
// enough to explain the requirement, and before node:sqlite is loaded.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `Threadbase needs Node.js 22.13 or newer (you have ${process.versions.node}).\n` +
      "Install the LTS version from https://nodejs.org and try again.",
  );
  process.exit(1);
}

// node:sqlite warns that it is experimental every time it loads. Silence just
// that warning, before the CLI (and with it node:sqlite) is imported.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  console.warn(`${warning.name}: ${warning.message}`);
});

const { main } = await import("./cli.ts");
process.exitCode = await main(process.argv.slice(2));
