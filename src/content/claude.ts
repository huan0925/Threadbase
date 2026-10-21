import { createClaudeClient } from "../providers/claude.ts";
import { runContentScript } from "./run.ts";

runContentScript(createClaudeClient((url, init) => fetch(url, init)));
