# IRC Ebook Downloader

<img width="1430" height="844" alt="image" src="https://github.com/user-attachments/assets/a3fe6187-cca2-4930-87e2-bdd251bd7e90" />


TUI for downloading ebooks from `#ebooks` on irchighway. Automates the
search → receive results zip → pick → download flow so you never touch a raw
IRC client.

> Use only for legally available / public-domain ebooks.

## Run

Requires **Node.js ≥ 16** ([nodejs.org](https://nodejs.org)) and a modern
terminal (Windows Terminal, iTerm2, or most Linux terminals — legacy `cmd.exe`
may not render the colors/icons). Works on Linux, macOS, and Windows.

Fastest — run it straight from the repo, no clone needed:

```bash
npx github:dev-kreg/IRCHighWay-ebook-downloader
```

From a clone:

```bash
npm install
npm start          # or: node index.js
npm install -g .   # or install it as a command: then just `ebook-dl`
```

No Node? Grab a standalone binary for your OS from the
[Releases](../../releases) page (Linux / macOS / Windows).

> **macOS:** the binaries are unsigned, so Gatekeeper blocks them on first run.
> Clear the quarantine flag once, then run:
>
> ```bash
> xattr -d com.apple.quarantine ./irc-ebook-downloader-macos-*
> ./irc-ebook-downloader-macos-arm64   # or -x64 on Intel
> ```

Downloads go to `~/Downloads/ebooks` by default. No port-forwarding needed —
transfers dial out to the bot, so it works behind home routers.

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
| `FORMATS` | `epub` (comma-separated, e.g. `epub,mobi`) |
| `BLOCK_PROVIDERS` | `Dumbledore` (hide these serving bots; set empty to disable) |

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
