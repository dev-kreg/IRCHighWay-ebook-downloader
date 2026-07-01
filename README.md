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

## Features

**Results table.** Each result is broken into aligned columns instead of a raw
bot line:

```
   Author            Title                    Extras              Size   Source
 ★ Matt Dinniman     This Inevitable Ruin     retail             3.1MB      Bsk  [✓6 ✗0]
   Matt Dinniman     Dungeon Crawler Carl     DCC 02, retail   457.6KB  Oatmeal  [✓4 ✗0]
```

- **★** flags the best picks — anything marked *retail* or proofed to
  **v3.0+** (higher-quality scans/sources).
- **Extras** collects the bracketed/parenthesised tags from the filename —
  series, edition, proofing version, `retail`, format notes.
- **Source** is the serving bot, with its running reliability record
  `[✓ succeeded ✗ failed]` — how often *that* bot's downloads have worked for
  you, remembered across runs (see [State](#state)).
- Results are **sorted best-first** by a quality score (proofing version,
  `retail` tag, plausible file size).
- Books you've already downloaded show a **green row**, so repeat searches make
  it obvious what you already have.

**Filtering.** Press **`/`** to narrow the visible results by typed text
(matches any column — author, title, extras, or source); **Esc** clears it.
This is instant and client-side — no new IRC search. To permanently hide bots
that reliably fail, set [`BLOCK_PROVIDERS`](#config-env-vars) (default:
`Dumbledore`).

**Search feedback.** While a search is in flight a large centered spinner shows
SearchBot's own live progress (*accepted → searching → returned N matches*).
A new search clears the old results immediately, and an empty result set shows
a clear "no results" message.

**Download tracking.** Select a row and press **Enter** to download:

- The row turns **amber** while queued/transferring, **green** on success,
  **red** on failure — readable at a glance across a whole batch.
- An **Active Downloads** panel below the results lists everything in flight
  (queued / receiving % / done / failed), so a batch doesn't require scrolling.
- You can queue **several downloads at once**; each finished transfer is matched
  back to the correct row by filename, even when bots reply out of order.

## Keys

- Type in the top box, **Enter** to `@search`.
- **↑/↓** move the results list, **Enter** downloads the highlighted book.
- **`/`** filter the current results by text, **Esc** clears the filter.
- **Tab** toggles focus between search box and list (or click the search box).
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
| `DEBUG` | `0` (set `1` to mirror the status log to a file) |
| `DEBUG_LOG` | `./debug.log` (used when `DEBUG=1`) |

## State

Two small JSON files under `~/.config/irc-ebook-dl/` persist across runs:

- `providers.json` — each bot's success/fail tally (the `[✓ ✗]` badge).
- `downloaded.json` — which books you've fetched (per bot), for the green rows.

Delete them to reset. Override their locations with `PROVIDER_STATS` /
`DOWNLOADED_FILE` if you want them elsewhere.

## Known limits

- Handles **zip** result archives only; `.rar` results are flagged, not unpacked
  (install `unrar` support if a bot uses it).
- Active DCC only — no passive/reverse DCC (port 0) or RESUME. irchighway's
  bots use active DCC, so this is fine in practice.

## Self-checks

Each module runs its own assertions when executed directly — no test framework:

```bash
node dcc.js          # DCC offer parsing
node parse.js        # results parsing, ranking, out-of-order matching
node providers.js    # provider success/fail stats
node downloaded.js   # downloaded-book tracking
```
