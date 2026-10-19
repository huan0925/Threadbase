import { createGeminiClient } from "../providers/gemini.ts";
import { runContentScript } from "./run.ts";

runContentScript(createGeminiClient((url, init) => fetch(url, init)));
