# Backlog

What's left to do, roughly in priority order. Tick items off (or move them to
the README roadmap) as they ship.

## In progress

- [ ] **Verify Gemini paging past 100 chats on the real site.** v0.4.4 pages
      the chat list by reloading the sync tab with the next-page token. Being
      tested against a real account with more than 100 chats.

## Done

- [x] **Back up and restore your data** (v0.6.0). Popup → Back up & restore.
      Download a `.json` backup (or Markdown to read), and import it again.
      Import adds missing chats and keeps the newer copy of each.

## Next

- [ ] **Repo cleanup.**
  - [x] Create `main` and open a PR into it
        ([huan0925/Threadbase#1](https://github.com/huan0925/Threadbase/pull/1)).
  - [ ] Merge the PR (owner), then make `main` the default branch
        (Settings → General → Default branch).
  - [ ] Delete the old v0.1.0–v0.1.2 CLI releases and their tags (owner, manual).
- [ ] **Chrome Web Store listing.** This also gives automatic updates.
  - Remove `key` from the uploaded manifest. The store assigns its own ID,
    so store users start fresh or restore a backup.
  - Needs a Chrome Web Store developer account ($5, one-time; owner).
  - Needs a privacy policy page, the listing text and screenshots
    (can be prepared in the repo).

## Missing data

- [ ] ChatGPT archived chats.
- [ ] Chats inside ChatGPT Projects.
- [ ] Gemini chats with more than 100 turns (only the first page of turns is
      saved).
- [ ] Images and attachments (all services save text only).

## Later

- [ ] More services: Perplexity, Microsoft Copilot, Grok, DeepSeek.
- [ ] Render Markdown (code blocks, lists, tables) in the saved-copy viewer.
- [ ] Firefox support.
- [ ] Full-text index for very large histories. Since v0.7.0 the popup opens
      without reading every chat, and searches scan newest-first, stopping
      at 50 results. A search that matches nothing still reads every chat's
      text, about 4 s at 20,000 chats. Reading the text from IndexedDB is
      the floor, so going faster needs an index (for example SQLite FTS via
      sqlite-wasm). It must still find 2-character Chinese words, which
      FTS5's trigram tokenizer can't.
