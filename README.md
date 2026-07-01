# IRC Ebook Downloader

TUI for downloading ebooks from `#ebooks` on irchighway. Automates the
search → receive results zip → pick → download flow so you never touch a raw
IRC client.

> Use only for legally available / public-domain ebooks.

## Run

```bash
npm install
npm start        # or: node index.js
```

Downloads go to `~/Downloads/ebooks` by default.

## Keys

- Type in the top box, **Enter** to `@search`.
- **↑/↓** move the results list, **Enter** downloads the highlighted book.
- **Tab** toggles focus between search box and list.
- **q** / **Ctrl-C** quits.

## Flow

1. Connects to `irc.irchighway.net` and joins `#ebooks`.
2. irchighway enforces a **~60s wait after joining** before `@search` works —
   the status pane shows the channel's notice; just wait if a search is ignored.
3. `@search <term>` → SearchBot sends a results **zip** over DCC → it's unpacked
   and every `!Bot ...` line is listed.
4. Selecting a line sends that `!Bot ...` command → the book bot sends the file
   over DCC → saved to the downloads dir.

## Config (env vars)

| Var | Default |
|-----|---------|
| `IRC_HOST` | `irc.irchighway.net` |
| `IRC_PORT` | `6667` |
| `IRC_TLS` | `0` (set `1` for TLS) |
| `IRC_CHANNEL` | `#ebooks` |
| `IRC_NICK` | `reader<random>` |
| `DOWNLOAD_DIR` | `~/Downloads/ebooks` |

## Known limits

- Handles **zip** result archives only; `.rar` results are flagged, not unpacked
  (install `unrar` support if a bot uses it).
- Active DCC only — no passive/reverse DCC (port 0) or RESUME. irchighway's
  bots use active DCC, so this is fine in practice.

## Self-checks

```bash
node dcc.js      # DCC offer parsing
node parse.js    # results parsing
```
