#!/usr/bin/env node
'use strict';
// IRC ebook downloader — TUI. Connects to #ebooks, sends @search, receives the
// SearchBot results zip over DCC, lets you pick a result, sends the download
// command, and receives the book over DCC. See README.md.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
// Correct file:// URL on every OS (Windows paths have backslashes + a drive
// letter that a hand-built "file://" + path would mangle).
const fileUrl = (p) => pathToFileURL(p).href;
const IRC = require('irc-framework');
const dcc = require('./dcc');
const { parseResultsZip, isSupportedArchive, filterFormats, scoreResult, providerOf, splitFields, sizeOf, versionOf, isRetail, takePendingBook } = require('./parse');
const { createUI } = require('./ui');
const providers = require('./providers');
const providerStats = providers.load();
const downloaded = require('./downloaded');
const downloadedStore = downloaded.load();

const cfg = {
  host: process.env.IRC_HOST || 'irc.irchighway.net',
  port: Number(process.env.IRC_PORT || 6667),
  tls: process.env.IRC_TLS === '1',
  channel: process.env.IRC_CHANNEL || '#ebooks',
  // A unique-ish nick; the channel rejects obvious bots/dupes.
  nick: process.env.IRC_NICK || 'reader' + Math.floor(Math.random() * 100000),
  downloadDir: process.env.DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'ebooks'),
  // Only show these formats in results. Comma-separated, e.g. FORMATS=epub,mobi
  formats: (process.env.FORMATS || 'epub').split(',').map((s) => s.trim()).filter(Boolean),
  // Providers (serving bots) to hide from results — e.g. ones that reliably
  // fail. Comma-separated, case-insensitive. Set BLOCK_PROVIDERS= to disable.
  blockProviders: new Set((process.env.BLOCK_PROVIDERS ?? 'Dumbledore')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
  debug: process.env.DEBUG === '1',
  debugLog: process.env.DEBUG_LOG || path.join(__dirname, 'debug.log'),
};

const ui = createUI({
  onSearch: (q) => search(q),
  onSelect: (r) => download(r),
  onQuit: () => { try { client.quit('bye'); } catch (_) {} ui.destroy(); process.exit(0); },
});

// Debug mode: mirror every status line (tags stripped) to a log file.
if (cfg.debug) {
  const orig = ui.status;
  ui.status = (msg) => {
    fs.appendFile(cfg.debugLog, new Date().toISOString() + ' ' + String(msg).replace(/\{[^}]*\}/g, '') + '\n', () => {});
    orig(msg);
  };
}

ui.status(`{cyan-fg}Connecting to ${cfg.host}:${cfg.port} as ${cfg.nick}...{/}`);
ui.status(`Downloads: ${fileUrl(cfg.downloadDir)}  {grey-fg}(Ctrl+Click to open){/}`);
if (cfg.debug) ui.status(`{grey-fg}debug: logging to ${cfg.debugLog}{/}`);

const client = new IRC.Client();
let joined = false;
let pendingSearch = false;
// Requested result items — matched to incoming book DCC offers by filename (see
// takePendingBook) so we can drive that row's progress/result and record the
// provider's success/fail, even if a later request's bot answers first.
const pendingBooks = [];

client.connect({
  host: cfg.host, port: cfg.port, tls: cfg.tls, nick: cfg.nick,
  username: cfg.nick, gecos: cfg.nick, version: 'mIRC',
});

client.on('registered', () => {
  ui.status('{green-fg}Connected.{/} Joining ' + cfg.channel + '...');
  client.join(cfg.channel);
});

client.on('join', (e) => {
  if (e.nick === cfg.nick && !joined) {
    joined = true;
    ui.status('{green-fg}Joined ' + cfg.channel + '.{/} irchighway makes you wait ~60s before @search works.');
    ui.focusSearch();
  }
});

// Surface channel/bot notices (incl. the "wait 60s" and search-in-progress msgs).
// While a search is in flight, SearchBot's own step-by-step notices (accepted,
// searching, "returned N matches") also surface under the big spinner.
client.on('notice', (e) => {
  const msg = clean(e.message);
  ui.status('{yellow-fg}[notice]{/} ' + msg);
  if (pendingSearch) ui.setSearchStep(msg);
});
client.on('message', (e) => {
  if (e.type === 'notice') return; // irc-framework double-emits notices as 'message'; the notice handler owns those
  if (e.target === cfg.channel) return; // ignore channel chatter
  ui.status('{grey-fg}[' + e.nick + ']{/} ' + clean(e.message)); // PMs from bots
});

client.on('ctcp request', (e) => {
  if (e.type !== 'DCC') return;
  const offer = dcc.parseOffer(e.message);
  if (!offer) return;
  const name = offer.filename;
  const looksLikeResults = /searchbot|results.?for/i.test(name) || (pendingSearch && /\.zip$/i.test(name));

  if (looksLikeResults) ui.setSearching(false); // bot responded; stop the search spinner

  if (looksLikeResults && !isSupportedArchive(name)) {
    ui.status('{red-fg}Results came as ' + name + ' (not .zip) — cannot unpack.{/}');
    pendingSearch = false;
    return;
  }

  const bookItem = looksLikeResults ? null : takePendingBook(pendingBooks, name);
  // Tag book-related log lines with the title explicitly — some failure
  // messages (e.g. a bare socket error) don't otherwise say which book they're
  // about, which is exactly what made past failures hard to follow.
  const tag = bookItem ? '{grey-fg}[' + bookItem.title + ']{/} ' : '';
  ui.status(tag + '{cyan-fg}Receiving{/} ' + name + ' (' + human(offer.size) + ')...');
  if (bookItem) ui.setRowProgress(bookItem, 0);
  let lastTick = 0;
  dcc.receive(offer, cfg.downloadDir, (recv, total) => {
    if (!bookItem) return; // results zip: no per-row progress
    const now = Date.now();
    if (now - lastTick > 150 || recv >= total) {
      lastTick = now;
      ui.setRowProgress(bookItem, total ? (recv / total) * 100 : 0);
    }
  }).then((filepath) => {
    if (looksLikeResults) {
      pendingSearch = false;
      const all = parseResultsZip(filepath);
      fs.rm(filepath, () => {}); // parsed into memory; drop the zip so it doesn't pollute the downloads/bookdrop dir
      const items = filterFormats(all, cfg.formats)
        .filter((r) => !cfg.blockProviders.has(providerOf(r.cmd).toLowerCase()));
      if (!items.length) {
        ui.status('{red-fg}No ' + cfg.formats.join('/') + ' in ' + all.length + ' results.{/} Set FORMATS env to widen.');
        return ui.showEmpty('No {bold}' + cfg.formats.join('/') + '{/bold} results\n' +
          '{grey-fg}(' + all.length + ' total, set FORMATS env to widen){/}');
      }
      // Rank by apparent quality, best first. Annotate each row with the serving
      // bot's success/fail record (display only — does not affect the sort).
      for (const r of items) r.score = scoreResult(r);
      items.sort((a, b) => b.score - a.score);
      // Structured fields for ui.js's column layout; r.label stays the raw bot
      // line (sizeOf/scoreResult read it) and is not shown directly anymore.
      for (const r of items) {
        r.provider = providerOf(r.cmd);
        const f = splitFields(r.cmd, r.provider);
        r.author = f.author;
        r.title = f.title;
        r.extras = f.extras;
        r.sizeText = sizeOf(r.label) ? human(sizeOf(r.label)) : '';
        // Star: proofed to v3+ or sourced retail — a real quality signal either way.
        r.top = versionOf(r.label) >= 3 || isRetail(r.label);
        r.downloaded = downloaded.has(downloadedStore, r.provider, r.author, r.title);
        const t = providers.tag(providerStats, r.provider); // "✓3 ✗1"
        r.statsText = t
          ? '  {grey-fg}[{/}' + t.replace(/✓\d+/, '{green-fg}$&{/}').replace(/✗\d+/, '{red-fg}$&{/}') + '{grey-fg}]{/}'
          : '';
      }
      ui.setResults(items);
      ui.status('{green-fg}' + items.length + '/' + all.length + ' results{/} (' + cfg.formats.join(',') + '). ↑↓ + Enter.');
    } else {
      if (bookItem) {
        providers.record(providerStats, bookItem.provider, true);
        downloaded.record(downloadedStore, bookItem.provider, bookItem.author, bookItem.title);
        ui.setRowResult(bookItem, true);
      }
      ui.status(tag + '{green-fg}Saved{/} ' + fileUrl(filepath) + '  {grey-fg}| folder:{/} ' + fileUrl(cfg.downloadDir));
    }
  }).catch((err) => {
    if (bookItem) { providers.record(providerStats, bookItem.provider, false); ui.setRowResult(bookItem, false); }
    ui.status(tag + '{red-fg}Transfer failed:{/} ' + err.message);
  });
});

client.on('socket close', () => {
  joined = false;
  ui.setSearching(false);
  ui.status('{red-fg}Disconnected.{/}');
});
client.on('error', (e) => ui.status('{red-fg}IRC error:{/} ' + (e && e.message || e)));

function search(q) {
  if (!joined) return ui.status('{red-fg}Not in channel yet.{/}');
  ui.clearResults();
  pendingSearch = true;
  ui.setSearching(true);
  ui.status('{cyan-fg}@search{/} ' + q);
  client.say(cfg.channel, '@search ' + q);
}

// Recently-requested commands, to swallow accidental double-fires (key repeat,
// double-click). Per-command so distinct books queued quickly still go through.
const recentReqs = new Set();
const DEBOUNCE_MS = 3000;

function download(r) {
  if (!joined) return ui.status('{red-fg}Not in channel yet.{/}');
  if (recentReqs.has(r.cmd)) return; // accidental double-fire; not worth a log line
  recentReqs.add(r.cmd);
  setTimeout(() => recentReqs.delete(r.cmd), DEBOUNCE_MS);
  pendingBooks.push(r);
  ui.setRowQueued(r);
  ui.status('{cyan-fg}Requesting{/} ' + r.cmd);
  client.say(cfg.channel, r.cmd);
}

function trunc(s) { return (s || '').length > 200 ? s.slice(0, 200) + '…' : s; }
// Strip mIRC/IRC formatting (color, bold, etc.) that bots pepper into notices,
// and collapse the alignment padding, so the status line stays readable.
function clean(s) {
  return trunc((s || '')
    .replace(/\x03\d{0,2}(,\d{1,2})?/g, '') // mIRC color: ^C[fg[,bg]]
    .replace(/\x04[0-9a-fA-F]{6}/g, '')     // hex color: ^D RRGGBB
    .replace(/[\x00-\x1f]/g, ' ')           // bold/italic/underline/reset + stray controls
    .replace(/\s{2,}/g, '  ')               // collapse alignment padding
    .trim());
}
function human(b) { if (!b) return '?'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return b.toFixed(1) + u[i]; }
