import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, styleText } from "node:util";
import { Store, type SearchHit } from "@threadbase/core";
import { importers, loadExport } from "@threadbase/importers";

const USAGE = `threadbase — search all your AI chat history in one place

Usage:
  threadbase import <export.zip|folder|conversations.json>... [--source <source>]
  threadbase search <query> [--source <source>] [--limit <n>] [--json]
  threadbase show <conversation-id> [--json]
  threadbase stats

Options:
  --db <path>        Database file (default: $THREADBASE_DB or ~/.threadbase/threadbase.db)
  --source <source>  One of: ${importers.map((i) => i.source).join(", ")}
  --limit <n>        Maximum results (default: 20)
  --json             Print machine-readable JSON
  -h, --help         Show this help

Search terms are AND-ed; wrap a phrase in double quotes to keep it together.`;

const sourceNames = new Map(importers.map((i) => [i.source, i.name]));

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      source: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const store = new Store(values.db ?? process.env.THREADBASE_DB ?? join(homedir(), ".threadbase", "threadbase.db"));
  try {
    switch (command) {
      case "import":
        return await importCommand(store, args, values.source);
      case "search":
        return searchCommand(store, args.join(" "), {
          source: values.source,
          limit: values.limit ? Number.parseInt(values.limit, 10) : undefined,
          json: values.json,
        });
      case "show":
        return showCommand(store, args[0], values.json);
      case "stats":
        return statsCommand(store);
      default:
        console.error(`Unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } finally {
    store.close();
  }
}

async function importCommand(store: Store, paths: string[], source: string | undefined): Promise<number> {
  if (paths.length === 0) {
    console.error("Usage: threadbase import <export.zip|folder|conversations.json>...");
    return 1;
  }
  let failed = false;
  for (const path of paths) {
    try {
      const { importer, conversations } = await loadExport(path, source);
      const stats = store.importAll(conversations);
      console.log(
        `${importer.name}: ${conversations.length} conversations from ${path} ` +
          `(${stats.conversationsAdded} new, ${stats.conversationsUpdated} updated, ` +
          `${stats.conversationsUnchanged} unchanged; ${stats.messagesAdded} new messages)`,
      );
    } catch (error) {
      failed = true;
      console.error(`Failed to import ${path}: ${(error as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

function searchCommand(
  store: Store,
  query: string,
  options: { source?: string; limit?: number; json: boolean },
): number {
  if (!query.trim()) {
    console.error("Usage: threadbase search <query>");
    return 1;
  }
  if (options.limit !== undefined && !(options.limit > 0)) {
    console.error("--limit must be a positive number");
    return 1;
  }
  const hits = store.search(query, options);
  if (options.json) {
    console.log(JSON.stringify(hits, null, 2));
    return 0;
  }
  if (hits.length === 0) {
    console.log("No matches.");
    return 0;
  }
  for (const hit of hits) printHit(hit);
  return 0;
}

function printHit(hit: SearchHit): void {
  const source = sourceNames.get(hit.source) ?? hit.source;
  console.log(
    `${styleText("cyan", `[${source}]`)} ${styleText("bold", hit.title)} ` +
      styleText("dim", `· ${formatDate(hit.createdAt)} · #${hit.conversationId}`),
  );
  console.log(`  ${styleText("dim", `${hit.role}:`)} ${highlight(hit.snippet, hit.terms)}`);
  if (hit.url) console.log(`  ${styleText("dim", hit.url)}`);
  console.log();
}

function showCommand(store: Store, idArg: string | undefined, json: boolean): number {
  const id = Number(idArg);
  if (!Number.isInteger(id)) {
    console.error("Usage: threadbase show <conversation-id>");
    return 1;
  }
  const conversation = store.getConversation(id);
  if (!conversation) {
    console.error(`No conversation #${id}`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify(conversation, null, 2));
    return 0;
  }
  const source = sourceNames.get(conversation.source) ?? conversation.source;
  console.log(styleText("bold", conversation.title));
  console.log(styleText("dim", `${source} · ${formatDate(conversation.createdAt)}`));
  if (conversation.url) console.log(styleText("dim", conversation.url));
  for (const message of conversation.messages) {
    const label = [message.role, message.model].filter(Boolean).join(" · ");
    console.log(`\n${styleText(message.role === "user" ? "green" : "cyan", `── ${label} ──`)}`);
    console.log(message.content);
  }
  return 0;
}

function statsCommand(store: Store): number {
  const stats = store.stats();
  if (stats.length === 0) {
    console.log("Nothing imported yet. Try: threadbase import <export.zip>");
    return 0;
  }
  for (const { source, conversations, messages } of stats) {
    console.log(`${sourceNames.get(source) ?? source}: ${conversations} conversations, ${messages} messages`);
  }
  return 0;
}

function formatDate(ms: number | null): string {
  return ms === null ? "unknown date" : new Date(ms).toISOString().slice(0, 10);
}

function highlight(text: string, terms: string[]): string {
  if (terms.length === 0) return text;
  const pattern = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return text.replace(pattern, (match) => styleText("yellow", match));
}
