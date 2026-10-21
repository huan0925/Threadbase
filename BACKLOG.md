# Backlog

What's left to do, roughly in priority order. Tick items off (or move them to
the README roadmap) as they ship.

## In progress

- [ ] **Verify Gemini paging past 100 chats on the real site.** v0.4.4 pages
      the chat list by reloading the sync tab with the next-page token. Being
      tested against a real account with more than 100 chats.
- [ ] **Back up and restore your data.** Export everything Threadbase saved to
      a file, and import it again. That way the chats survive removing the
      extension, reinstalling it, or moving to another computer.

## Next

- [ ] **Repo cleanup.**
  - Create a `main` branch and open a PR from the development branch (only
    when asked).
  - Delete the old v0.1.0–v0.1.2 CLI releases on GitHub (manual).
- [ ] **Chrome Web Store listing.** This also gives automatic updates.
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
- [ ] Faster search for very large histories (full-text index, for example
      SQLite FTS via sqlite-wasm).
