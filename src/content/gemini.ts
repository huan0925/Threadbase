import { createGeminiClient } from "../providers/gemini.ts";
import { runContentScript } from "./run.ts";

runContentScript(
  createGeminiClient((url, init) => fetch(url, init), {
    scripts: () => [...document.scripts].map((script) => script.textContent ?? "").join("\n"),
    path: () => location.pathname,
    language: () => document.documentElement.lang || null,
  }),
);
