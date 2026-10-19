import { createChatGPTClient } from "../providers/chatgpt.ts";
import { runContentScript } from "./run.ts";

runContentScript(createChatGPTClient((url, init) => fetch(url, init)));
