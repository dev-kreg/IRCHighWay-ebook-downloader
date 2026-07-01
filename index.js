#!/usr/bin/env node
'use strict';
// IRC ebook downloader — TUI. Connects to #ebooks, sends @search, receives the
// SearchBot results zip over DCC, lets you pick a result, sends the download
// command, and receives the book over DCC. See README.md.
const fs = require('fs');
const path = require('path');
const os = require('os');
const IRC = require('irc-framework');
const dcc = require('./dcc');
const { parseResultsZip, isSupportedArchive, filterFormats, scoreResult, providerOf } = require('./parse');
const { createUI } = require('./ui');
const providers = require('./providers');
const providerStats = providers.load();

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
ui.status(`Downloads: file://${cfg.downloadDir}  {grey-fg}(Ctrl+Click to open){/}`);
if (cfg.debug) ui.status(`{grey-fg}debug: logging to ${cfg.debugLog}{/}`);

const client = new IRC.Client();
let joined = false;
let pendingSearch = false;
// Requested result items, FIFO — matched to incoming book DCC offers so we can
// drive that row's progress/result and record the provider's success/fail.
// ponytail: assumes downloads resolve in request order; fine for interactive
// use, revisit if parallel downloads get reordered.
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
client.on('notice', (e) => ui.status('{yellow-fg}[notice]{/} ' + trunc(e.message)));
client.on('message', (e) => {
  if (e.type === 'notice') return; // irc-framework double-emits notices as 'message'; the notice handler owns those
  if (e.target === cfg.channel) return; // ignore channel chatter
  ui.status('{grey-fg}[' + e.nick + ']{/} ' + trunc(e.message)); // PMs from bots
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

  const bookItem = looksLikeResults ? null : pendingBooks.shift();
  ui.status('{cyan-fg}Receiving{/} ' + name + ' (' + human(offer.size) + ')...');
  if (bookItem) ui.waveRow(bookItem); // sweep animation until first bytes arrive
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
      const items = filterFormats(all, cfg.formats);
      if (!items.length) {
        return ui.status('{red-fg}No ' + cfg.formats.join('/') + ' in ' + all.length + ' results.{/} Set FORMATS env to widen.');
      }
      // Rank by apparent quality, best first. Annotate each row with the serving
      // bot's success/fail record (display only — does not affect the sort).
      for (const r of items) r.score = scoreResult(r);
      items.sort((a, b) => b.score - a.score);
      const topScore = items[0].score;
      for (const r of items) {
        r.provider = providerOf(r.cmd);
        const t = providers.tag(providerStats, r.provider); // "✓3 ✗1"
        const stats = t
          ? '  {grey-fg}[{/}' + t.replace(/✓\d+/, '{green-fg}$&{/}').replace(/✗\d+/, '{red-fg}$&{/}') + '{grey-fg}]{/}'
          : '';
        // Subtle marker for the best-scoring result(s); only when there's a real signal.
        const star = (r.score === topScore && topScore > 0) ? '{yellow-fg}★ {/}' : '';
        r.label = star + r.label + stats;
      }
      ui.setResults(items);
      ui.status('{green-fg}' + items.length + '/' + all.length + ' results{/} (' + cfg.formats.join(',') + '). ↑↓ + Enter.');
    } else {
      if (bookItem) { providers.record(providerStats, bookItem.provider, true); ui.setRowResult(bookItem, true); }
      ui.status('{green-fg}Saved{/} file://' + filepath + '  {grey-fg}| folder:{/} file://' + cfg.downloadDir);
    }
  }).catch((err) => {
    if (bookItem) { providers.record(providerStats, bookItem.provider, false); ui.setRowResult(bookItem, false); }
    ui.status('{red-fg}Transfer failed:{/} ' + err.message);
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
  if (recentReqs.has(r.cmd)) return ui.status('{yellow-fg}Ignored duplicate:{/} ' + r.cmd);
  recentReqs.add(r.cmd);
  setTimeout(() => recentReqs.delete(r.cmd), DEBOUNCE_MS);
  pendingBooks.push(r);
  ui.status('{cyan-fg}Requesting{/} ' + r.cmd);
  client.say(cfg.channel, r.cmd);
}

function trunc(s) { return (s || '').length > 200 ? s.slice(0, 200) + '…' : s; }
function human(b) { if (!b) return '?'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return b.toFixed(1) + u[i]; }
