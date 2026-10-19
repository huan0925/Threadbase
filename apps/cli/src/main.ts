#!/usr/bin/env node
// node:sqlite warns that it is experimental every time it loads. Silence just
// that warning, before the CLI (and with it node:sqlite) is imported.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  console.warn(`${warning.name}: ${warning.message}`);
});

const { main } = await import("./cli.ts");
process.exitCode = await main(process.argv.slice(2));
