# Threadbase

**One searchable place for all your AI chat history.**

You asked an AI something months ago and want the answer back, but you can't
remember whether it was ChatGPT or Claude. Threadbase is a Chrome extension
that quietly keeps a copy of your conversations from each service and lets
you search all of them at once.

- **No exports, no setup.** Stay signed in to chatgpt.com and claude.ai as
  usual. Threadbase reads your history through your own signed-in browser.
- **Stays on your computer.** Conversations are stored inside the extension
  in your browser. Nothing is sent to any server, and Threadbase never sees
  your password.
- **Works for every language.** Search matches any part of the text, so
  Chinese and Japanese queries work as well as English ones.

## Install

Threadbase isn't in the Chrome Web Store yet, so it's installed by hand. It
takes about a minute and works in Chrome, Edge, Brave, Arc and other
Chromium-based browsers.

1. Download **`threadbase-extension.zip`** from the
   [latest release](https://github.com/huan0925/Threadbase/releases/latest)
   and unzip it. Keep the folder somewhere permanent; the browser loads the
   extension from it.
2. Open `chrome://extensions` (in Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder.
5. Pin Threadbase: click the puzzle-piece icon in the toolbar, then the pin
   next to Threadbase.

**To update**, download the new zip, replace the folder's contents, and click
the reload icon on Threadbase's card in `chrome://extensions`. Your saved
chats are kept.

## Use

1. **Open [chatgpt.com](https://chatgpt.com) and [claude.ai](https://claude.ai)
   once while signed in.** Threadbase syncs your whole history in the
   background; the first sync can take a few minutes if you have many chats.
   You can keep using the site meanwhile.
2. **Click the Threadbase icon and type.** Every word must appear somewhere in
   the conversation; wrap a phrase in `"double quotes"` to keep it together.
   - Click a title to continue the conversation on its site.
   - Click **Saved copy** to read the copy stored in Threadbase, with your
     search terms highlighted, even if you deleted it on the site.
3. **Staying up to date is automatic.** Whenever you open one of the sites,
   Threadbase picks up new and changed chats (at most every 10 minutes).
   Chats you had on your phone are included, since they're part of your
   account. The **Sync** buttons in the popup sync right away, opening the
   site in a background tab if needed.

If the popup says **Sign in to …**, sign in on that site and press Sync again.

## Privacy

- Conversations are stored in the extension's own storage (IndexedDB) in your
  browser profile. To delete them, remove the extension.
- The extension only talks to chatgpt.com and claude.ai, from the sites' own
  tabs, using your existing session, the same way the sites' pages do.
- It requests access to those two sites only, plus storage permissions.

## Limitations

- Threadbase reads the same internal endpoints the sites' own pages use;
  they aren't official APIs. If a site changes them, syncing that site breaks
  until Threadbase is updated. Please
  [open an issue](https://github.com/huan0925/Threadbase/issues) if it does.
- Chats you delete on a site stay in Threadbase.
- ChatGPT archived chats and chats inside ChatGPT Projects may not be included
  yet.
- Firefox and Safari aren't supported yet.

## How it works

```
 chatgpt.com tab ─┐  content script reads your history    ┌─ popup: search
                  ├─ through the site's own endpoints ───►│  background worker → IndexedDB
 claude.ai tab ───┘  (src/providers/*)                    └─ view.html: saved copy
```

| Path | Purpose |
| ---- | ------- |
| `src/providers/` | One client per site: list conversations, fetch one, normalize it. |
| `src/sync.ts` | Downloads only conversations that are new or changed since the last sync. |
| `src/content/` | Runs in each site's tab and syncs with the user's session. |
| `src/background.ts` | Stores conversations, tracks sync status, opens a tab when Sync is pressed. |
| `src/search.ts` | In-memory search across all conversations. |
| `src/ui/` | The popup and the saved-copy viewer. |

Conversations are stored as trees, because editing or regenerating a message
creates branches; the viewer shows the branch you last saw.

## Development

Requires Node.js 22.18 or newer.

```sh
npm install
npm run build        # builds the extension into dist/; load that folder unpacked
npm run watch        # rebuilds on change; then reload the extension
npm test             # unit tests (node:test)
npm run typecheck
npm run test:e2e     # loads dist/ into Chromium against fake chatgpt.com / claude.ai
```

The end-to-end tests need Playwright's Chromium (`npx playwright install
chromium`) and `openssl`.

### Adding a service

1. Add a client in `src/providers/<service>.ts` implementing `ProviderClient`
   (`src/sync.ts`): list conversations newest first, fetch and normalize one.
2. Add a content script in `src/content/`, an entry in `scripts/build.mjs`,
   and the site to `public/manifest.json` (content script and
   `host_permissions`).
3. Add the source to `SourceId` in `src/types.ts` and to the popup.
4. Add tests with an anonymized sample response under `test/fixtures/`.
   Never commit real conversations.

### Releasing

Bump `version` in `package.json`, then open **Actions → Release → Run
workflow**. It runs all tests and publishes `threadbase-extension.zip` as a
GitHub Release.

## Roadmap

- [x] ChatGPT and Claude, automatic sync, search, saved copies
- [ ] Gemini
- [ ] Chrome Web Store listing
- [ ] Faster search for very large histories (SQLite full-text index)
- [ ] Export your Threadbase data
- [ ] Firefox

## License

[MIT](LICENSE)
