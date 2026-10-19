# Threadbase

**One searchable place for all your AI chat history.**

You asked an AI something months ago and want the answer back, but you can't
remember whether it was ChatGPT, Claude or Gemini. Threadbase imports the chat
exports from each service into a single local database and searches across all
of them.

- **Local-first.** Your conversations stay on your machine in one SQLite file.
  Nothing is uploaded anywhere.
- **Works with official exports.** No scraping and no stored passwords: you
  download your data from each service and point Threadbase at the file.
- **Built for CJK too.** Full-text search uses a trigram index, so Chinese and
  Japanese queries work without word segmentation.
- **Safe to re-import.** Import a fresh export every month; only new messages
  are added.

## Supported sources

| Source  | How to export                                   | File to import                      |
| ------- | ----------------------------------------------- | ----------------------------------- |
| ChatGPT | Settings → Data controls → Export data          | the emailed `.zip` (or `conversations.json`) |
| Claude  | Settings → Privacy → Export data                | the emailed `.zip` (or `conversations.json`) |

More importers are on the [roadmap](#roadmap). Each importer is a small,
self-contained parser, so adding one is a great first contribution.

## Quick start

Requires Node.js 22.18 or newer and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm tb import ~/Downloads/chatgpt-export.zip ~/Downloads/claude-export.zip
pnpm tb search 房貸 利息
pnpm tb show 12
```

```
[ChatGPT] 報稅文件整理 · 2024-03-12 · #12
  user: 房貸利息可以扣除嗎？
  https://chatgpt.com/c/…
```

Commands:

| Command | Description |
| ------- | ----------- |
| `import <file>... [--source chatgpt\|claude]` | Import exports; the source is auto-detected. |
| `search <query> [--source s] [--limit n] [--json]` | Terms are AND-ed; use `"double quotes"` for a phrase. |
| `show <id> [--json]` | Print a conversation (the branch you last saw, for branched chats). |
| `stats` | Count conversations and messages per source. |

The database lives at `~/.threadbase/threadbase.db`; override it with `--db`
or `THREADBASE_DB`.

## How it works

```
 export.zip ──► importer ──► NormalizedConversation ──► Store (SQLite + FTS5) ──► CLI
               (per source)    (packages/core/types)
```

| Package | Purpose |
| ------- | ------- |
| `packages/core` | The normalized schema, the SQLite store and search. |
| `packages/importers` | One parser per source plus zip/JSON loading and auto-detection. |
| `apps/cli` | The `threadbase` command. |

Conversations are stored as trees, because editing or regenerating a message
creates branches (ChatGPT exports every branch). Each conversation also keeps
the provider's raw record, so an improved parser can re-derive data later
without asking you to export again.

## Development

```sh
pnpm test        # node:test, runs the TypeScript sources directly
pnpm typecheck
pnpm build       # emits dist/ for publishing
```

TypeScript runs natively through Node's type stripping, so the code avoids
non-erasable syntax (`enum`, parameter properties, namespaces).

### Adding an importer

1. Create `packages/importers/src/<source>/index.ts` exporting an `Importer`
   (see `packages/core/src/types.ts`).
2. Register it in `packages/importers/src/index.ts`.
3. Add an anonymized sample export under `packages/importers/test/fixtures/`
   and tests next to it. Never commit real conversations.

## Roadmap

- [x] ChatGPT and Claude importers, full-text search, CLI
- [ ] Gemini (Google Takeout) and Claude Code / Codex CLI session logs
- [ ] Local web UI
- [ ] Semantic search with local embeddings (sqlite-vec + Ollama)
- [ ] MCP server, so any AI assistant can search your past conversations
- [ ] Browser extension for automatic sync and services without exports

## License

[MIT](LICENSE)
