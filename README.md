# Threadbase

**One searchable place for all your AI chat history.**

You asked an AI something months ago and want the answer back, but you can't
remember whether it was ChatGPT, Claude or Gemini. Threadbase is a Chrome extension
that quietly keeps a copy of your conversations from each service and lets
you search all of them at once.

- **No exports, no setup.** Stay signed in to chatgpt.com, claude.ai and
  gemini.google.com as usual. Threadbase reads your history through your own signed-in browser.
- **Stays on your computer.** Conversations are stored inside the extension
  in your browser. Nothing is sent to any server, and Threadbase never sees
  your password.
- **Works for every language.** Search matches any part of the text, so
  Chinese and Japanese queries work as well as English ones.

## Install

Threadbase isn't in the Chrome Web Store yet, so it's installed by hand. It
takes about a minute and works in Chrome, Edge, Brave, Arc and other
Chromium-based browsers.

1. Download **`threadbase-extension.zip`** from the **Assets** of the
   [latest release](https://github.com/huan0925/Threadbase/releases/latest),
   **not** "Source code", which GitHub adds to every release. Unzip it and
   keep the folder somewhere permanent; the browser loads the extension from
   it. The folder should contain `manifest.json` directly.
2. Open `chrome://extensions` (in Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder.
5. Pin Threadbase: click the puzzle-piece icon in the toolbar, then the pin
   next to Threadbase.

### Updating

> [!WARNING]
> **Clicking Remove on Threadbase in `chrome://extensions` deletes all your
> saved chats.** Chrome deletes an extension's data when you remove it, even
> if you install the same extension again right after. To update, don't
> remove the old version. Reload it instead, as below.

**Recommended: keep the old version and reload.** Your saved chats are kept.

1. Download the new `threadbase-extension.zip`.
2. Unzip it over the old folder, replacing its files.
3. In `chrome://extensions`, click the reload icon (↻) on Threadbase's card.

**Moving or renaming the folder.** Chrome loads Threadbase from its
folder, so once the folder is moved or renamed, Threadbase can't load from
its old location. Right away, click **Load unpacked** in
`chrome://extensions` and select the folder in its new place. Your chats
are kept: they belong to Threadbase's extension ID, which stays the same
wherever the folder is. To be safe, download a backup before moving it.

**If you must remove the old version**, back up first:

1. In the old version, click **Back up & restore** at the bottom of the popup,
   then **Download backup (.json)**.
2. Remove the old version, then install the new one with **Load unpacked**.
3. In the new version, open **Back up & restore** and choose the backup file
   under **Restore**.

Restoring takes seconds. The next sync only picks up chats that changed
since the backup, so nothing is downloaded again.

**Updating from v0.6.0 or earlier to v0.6.1 or later** is a one-time
exception. Versions before 0.6.1 had no fixed extension ID, so the new
version starts empty. To bring your chats over:

1. Download a backup from the old version.
2. Load the new version from a new folder with **Load unpacked**.
3. Restore the backup in the new version.
4. Remove the old version.

## Use

1. **Open [chatgpt.com](https://chatgpt.com), [claude.ai](https://claude.ai)
   and [gemini.google.com](https://gemini.google.com) once while signed in.** Threadbase syncs your whole history in the
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
4. **Scheduled syncs.** While Chrome is open, Threadbase also syncs on its
   own every hour (choose 30 min to 6 h, or off, under **Auto-sync** in the
   popup), skipping services that synced recently anyway. It works in
   background tabs and never interrupts you: if a service needs you to sign
   in or pass a robot check, the popup says so and the tab is closed.

**Gemini syncs differently.**
- The first Gemini sync is much slower: about 5 seconds per chat, so 100
  chats take roughly 10 minutes.
- While it runs, a Gemini tab stays open in the background. Leave it alone;
  closing it stops the sync.
- If Google asks you to confirm you're not a robot, the sync stops and that
  tab comes to the front. Finish the check, then press **Sync**. It carries
  on where it left off.

[Why Gemini is different](#why-gemini-is-different) explains why.

**Back up your chats.** They live only in this browser, so removing
Threadbase deletes them. Click **Back up & restore** at the bottom of the
popup to download everything as a `.json` backup (or as a Markdown file to
read). On another computer, or after reinstalling, choose that `.json` file
on the same page to restore it. Restoring only adds chats or replaces them
with a newer copy; it never deletes anything.

If the popup says **Sign in to …**, sign in on that site and press Sync again.

**"Manifest file is missing or unreadable"** when loading means the selected
folder isn't the extension: you probably downloaded "Source code" instead of
`threadbase-extension.zip`, or picked the folder one level above
`manifest.json`.

## Why Gemini is different

**ChatGPT and Claude are simple.** Their web pages load your chat list and
each chat with plain requests to the site. Threadbase sends the same
requests from the site's own tab, using your signed-in session. It needs no
extra tab and fetches many chats a minute.

**Gemini only answers its own page.** Google rejects Gemini requests that
weren't made by the Gemini page's own code. Threadbase tried sending the same
requests itself, with the page's tokens and headers, and Google turned every
one down. So Threadbase can't ask Gemini for your chats. Instead it works
alongside the page:

1. A small script inside the Gemini page reads the replies to the page's
   own requests: the chat list in the sidebar, and each chat as it loads.
   It doesn't send requests of its own.
2. To sync, Threadbase opens a Gemini tab in the background. It clicks each
   new or changed chat in Gemini's own sidebar, one at a time, and saves
   what the page loads.
3. It waits a few seconds between chats, at a pace like a person reading.
   Opening chats much faster makes Google suspect a robot.

**What this means for you:**

- **The first sync is slow.** It takes about 5 seconds per chat. After that,
  only new and changed chats are opened, so later syncs are quick.
- **A tab is open while it syncs.** It closes by itself when done.
- **Google may still ask for a robot check.** Threadbase never answers it
  for you. It stops and shows you the tab, and you finish the check
  yourself.
- **Chats you open yourself are saved right away**, since the page loads
  them anyway.
- **Gemini is the most likely to break.** Its replies are unlabeled lists
  of values. Threadbase finds titles, messages and dates by their position
  in those lists, so when Google changes the page, Gemini sync may need a
  Threadbase update.

## What's included

Threadbase saves what each site's **web version** shows in its chat history,
for the account signed in on that site in this browser.

- **Included:** chats from the sites' phone and desktop apps, because they're
  stored in your account and show up on the website too.
- **Not included:**
  - Chats the services never keep in your history: ChatGPT's Temporary
    Chat, Claude's incognito chats, and Gemini chats made while Gemini Apps
    Activity is off.
  - Other accounts. Only the account signed in on each site is synced. For
    Gemini with several Google accounts signed in, that's the default
    account.
  - Chats you deleted on a site before Threadbase saved them.
  - For what isn't synced yet (archived ChatGPT chats, ChatGPT Projects,
    images and files), see [Limitations](#limitations).

## Privacy

- Conversations are stored in the extension's own storage (IndexedDB) in your
  browser profile. To delete them, remove the extension. Backups are files
  you download yourself; Threadbase doesn't upload them anywhere.
- The extension only talks to chatgpt.com, claude.ai and gemini.google.com,
  from the sites' own tabs, using your existing session, the same way the
  sites' pages do.
- It requests access to those three sites only, plus storage permissions.
- On gemini.google.com, a small script also runs inside the page. It reads
  the responses to the page's own requests that list and load chats, so
  Threadbase never sends Gemini requests of its own. In the background tab a
  sync opens, it asks those requests for more chats per page. It doesn't
  read or change anything else, and keeps everything in the page.

## Limitations

- Threadbase reads the same internal endpoints the sites' own pages use;
  they aren't official APIs. If a site changes them, syncing that site breaks
  until Threadbase is updated. Please
  [open an issue](https://github.com/huan0925/Threadbase/issues) if it does.
- Gemini's internal format is unlabeled positional data, mapped from
  recordings of the live site, so it's the most likely to need fixes. For
  Gemini, only the reply draft you chose is saved, and images and files
  aren't. Very long Gemini chats (over 100 turns) may only be saved in part.
- Chats you delete on a site stay in Threadbase.
- ChatGPT archived chats and chats inside ChatGPT Projects may not be included
  yet.
- Firefox and Safari aren't supported yet.

## How it works

```
 chatgpt.com tab ───────┐  content script reads your history    ┌─ popup: search
 claude.ai tab ─────────┼─ through the site's own endpoints ───►│  background worker → IndexedDB
 gemini.google.com tab ─┘  (src/providers/*)                    └─ view.html: saved copy
```

Gemini is the exception: `src/content/gemini-page.ts` reads the responses to
the Gemini page's own requests, and `src/gemini-backfill.ts` steers a
background tab through the chats that need syncing.

| Path | Purpose |
| ---- | ------- |
| `src/providers/` | One client per site: list conversations, fetch one, normalize it. |
| `src/sync.ts` | Downloads only conversations that are new or changed since the last sync. |
| `src/content/` | Runs in each site's tab and syncs with the user's session. |
| `src/background.ts` | Stores conversations, tracks sync status, opens a tab when Sync is pressed. |
| `src/search.ts` | Search records (compact lowercased text) and matching; the popup scans them newest first. |
| `src/backup.ts` | Backup files: export, validate, merge on import, Markdown. |
| `src/ui/` | The popup, the saved-copy viewer, and the backup page. |

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

To learn a site's internal API without sharing anyone's chats, record the
site's traffic in DevTools (Network → Export HAR, sanitized) and run
`node tools/har-shape.mjs recording.har <host>`. It prints the structure of
every JSON and batchexecute call with all text masked to its length. Delete
the HAR file afterwards; it contains the conversations.

### Releasing

Bump `version` in `package.json`, then open **Actions → Release → Run
workflow**. It runs all tests and publishes `threadbase-extension.zip` as a
GitHub Release.

## Roadmap

The full list of open work is in [BACKLOG.md](BACKLOG.md).

- [x] ChatGPT and Claude, automatic sync, search, saved copies
- [x] Gemini
- [ ] Chrome Web Store listing
- [x] Faster search: the popup no longer reads every chat when it opens, and searches stop at the newest 50 results
- [ ] Full-text index for very large histories
- [x] Back up and restore your Threadbase data
- [ ] Firefox

## Acknowledgements

Gemini's internal API details (RPC ids, request headers, response
positions) were cross-checked against
[HanaokaYuzu/Gemini-API](https://github.com/HanaokaYuzu/Gemini-API), a
reverse-engineered Python client for the Gemini web app.

## License

[MIT](LICENSE)
