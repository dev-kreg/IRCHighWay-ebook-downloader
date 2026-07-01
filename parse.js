'use strict';
// Parse a SearchBot results archive into selectable download commands.
// The archive is a zip containing one text file whose useful lines each start
// with "!" — e.g.  !Oatmeal Author - Title.epub  ::INFO:: 1.2MB
const AdmZip = require('adm-zip');

// Extract the "!..." command lines from a results zip. Returns [{cmd, label}].
// cmd is what we send back to the channel (trimmed before ::INFO::), label is
// the full line shown in the UI.
function parseResultsZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  let text = '';
  for (const e of entries) text += zip.readAsText(e) + '\n';
  return parseResultsText(text);
}

function parseResultsText(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('!')) continue;
    // The bot only reads up to the ::INFO:: marker; strip it and anything after.
    const cmd = line.split('::INFO::')[0].trim();
    out.push({ cmd, label: line });
  }
  return out;
}

// Some results arrive as .rar; we can't unpack those without unrar. Detect so
// the UI can tell the user instead of silently failing.
function isSupportedArchive(filename) {
  return /\.zip$/i.test(filename);
}

// Keep only results whose file extension is in `formats` (e.g. ['epub']).
function filterFormats(items, formats) {
  const re = new RegExp('\\.(' + formats.join('|') + ')\\b', 'i');
  return items.filter((r) => re.test(r.cmd));
}

// Proofing version from "(v3.0)" / "(v2)" in the name; 0 if none. Higher=better.
function versionOf(label) {
  const m = label.match(/\(v(\d+(?:\.\d+)?)\)/i);
  return m ? parseFloat(m[1]) : 0;
}

// "retail" tag in the name: sourced from a retailer, not OCR'd/proofed.
function isRetail(label) {
  return /\bretail\b/i.test(label);
}

// Provider = the serving bot, the first token: "!Oatmeal Author - ..." -> "Oatmeal".
function providerOf(cmd) {
  const m = cmd.match(/^!(\S+)/);
  return m ? m[1] : '';
}

// Split a result's command into displayable Author / Title / Extras. cmd looks
// like "!Provider Author - [Series] - Title (tags).ext"; extras are the
// bracket/paren groups (series, proofing version, retail, format tags).
// ponytail: heuristic split on " - ", not a real bibliographic parser; good
// enough for column display, revisit if titles with embedded " - " get common.
function splitFields(cmd, provider) {
  let rest = cmd.replace(new RegExp('^!' + provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*'), '');
  rest = rest.replace(/\.\w+$/, ''); // drop extension
  const extras = [];
  rest = rest.replace(/[[(]([^\])]+)[\])]/g, (_, inner) => { extras.push(inner.trim()); return ' '; });
  const parts = rest.split(/\s-\s/).map((s) => s.trim()).filter(Boolean);
  const author = parts.length > 1 ? parts[0] : '';
  const title = (parts.length > 1 ? parts.slice(1) : parts).join(' - ') || rest.trim();
  return { author, title, extras: extras.join(', ') };
}

// Filename the book bot echoes back on its DCC offer: cmd minus "!Provider ".
function filenameOf(cmd) {
  return cmd.slice(cmd.indexOf(' ') + 1);
}

// Pull the pending download matching an incoming DCC filename out of the queue
// (mutates it), instead of assuming offers resolve in request order — a
// faster/queued-ahead provider can finish before an earlier request, which
// would otherwise credit the wrong row's ✓/✗ and provider stats.
// ponytail: same-titled duplicates from different providers still resolve
// FIFO among themselves — DCC offers carry no real per-request correlation ID.
function takePendingBook(queue, filename) {
  if (!queue.length) return undefined;
  const idx = queue.findIndex((r) => filenameOf(r.cmd) === filename);
  return queue.splice(idx >= 0 ? idx : 0, 1)[0];
}

// File size in bytes from the "::INFO:: 1.2MB" trailer; 0 if absent.
function sizeOf(label) {
  const m = label.match(/([\d.]+)\s*(KB|MB|GB|B)\b/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2].toUpperCase()];
  return parseFloat(m[1]) * mult;
}

// Quality score for ranking (higher = better, shown first). Signals, in order of
// weight: proofing version, "retail" tag, sane file size. This is quality only —
// provider success/fail is intentionally NOT factored in yet.
// ponytail: retail (clean at the source, no OCR) is weighted about even with a
// v3 scan; only a heavily-proofed v4+ scan edges past it. Tune if that's wrong.
function scoreResult(item) {
  let s = versionOf(item.label) * 8;
  if (isRetail(item.label)) s += 25;
  const size = sizeOf(item.label);
  if (size) {
    if (size < 30 * 1024) s -= 5;              // <30KB: likely sample/broken
    else if (size <= 15 * 1024 ** 2) s += 2;   // 30KB–15MB: plausible epub
  }
  return s;
}

module.exports = {
  parseResultsZip, isSupportedArchive, filterFormats,
  versionOf, isRetail, providerOf, sizeOf, scoreResult, splitFields,
  takePendingBook,
};

if (require.main === module) {
  const sample = [
    'These are search results...',
    '!Oatmeal William Shakespeare - Romeo and Juliet.epub  ::INFO:: 250.5KB',
    '!Ook William Shakespeare - Romeo and Juliet.mobi ::INFO:: 300KB',
    'ignore this line',
  ].join('\n');
  const r = parseResultsText(sample);
  console.assert(r.length === 2, 'count', r.length);
  console.assert(r[0].cmd === '!Oatmeal William Shakespeare - Romeo and Juliet.epub', 'strip info', r[0].cmd);
  console.assert(isSupportedArchive('x.zip') && !isSupportedArchive('x.rar'), 'archive detect');
  console.assert(filterFormats(r, ['epub']).length === 1, 'epub filter', filterFormats(r, ['epub']).length);
  console.assert(versionOf('041 - Crichton - Jurassic Park (v3.0).epub') === 3.0, 'version parse');
  console.assert(versionOf('no version here.epub') === 0, 'no version');
  console.assert(providerOf('!Oatmeal Author - Title.epub') === 'Oatmeal', 'provider');
  console.assert(Math.round(sizeOf('x ::INFO:: 1.5MB')) === 1572864, 'size MB', sizeOf('x ::INFO:: 1.5MB'));
  const hi = { label: 'Book (v3.0) retail ::INFO:: 1.2MB' };
  const lo = { label: 'Book (v1.0) ::INFO:: 10KB' };
  console.assert(scoreResult(hi) > scoreResult(lo), 'ranking', scoreResult(hi), scoreResult(lo));
  const retailOnly = { label: 'Book retail ::INFO:: 1.2MB' };
  const v1Only = { label: 'Book (v1.0) ::INFO:: 1.2MB' };
  const v5Only = { label: 'Book (v5.0) ::INFO:: 1.2MB' };
  console.assert(scoreResult(retailOnly) > scoreResult(v1Only), 'retail beats low version', scoreResult(retailOnly), scoreResult(v1Only));
  console.assert(scoreResult(v5Only) > scoreResult(retailOnly), 'high version beats retail', scoreResult(v5Only), scoreResult(retailOnly));
  const f1 = splitFields("!Bsk Matt Dinniman - [Dungeon Crawler Carl 02] - Carl's Doomsday Scenario (retail)", 'Bsk');
  console.assert(f1.author === 'Matt Dinniman', 'split author', f1.author);
  console.assert(f1.title === "Carl's Doomsday Scenario", 'split title', f1.title);
  console.assert(f1.extras === 'Dungeon Crawler Carl 02, retail', 'split extras', f1.extras);
  const f2 = splitFields('!Bsk Matt Dinniman - This Inevitable Ruin.epub', 'Bsk');
  console.assert(f2.author === 'Matt Dinniman' && f2.title === 'This Inevitable Ruin', 'split no extras', f2);
  // Regression for the mixed-up ✓/✗ bug: three requests queued in order A,B,C,
  // but B's bot answers first — must return B, not blindly shift A.
  const qA = { cmd: '!Bsk Matt Dinniman - Operation Bounce House (Retail).epub' };
  const qB = { cmd: '!Oatmeal Matt Dinniman - Dominion of Blades (retail).epub' };
  const qC = { cmd: '!peapod Matt Dinniman - The Butcher\'s Masquerade (Retail).epub' };
  const queue = [qA, qB, qC];
  console.assert(takePendingBook(queue, 'Matt Dinniman - Dominion of Blades (retail).epub') === qB, 'out-of-order match');
  console.assert(queue.length === 2 && queue[0] === qA && queue[1] === qC, 'match removed only B', queue);
  console.assert(takePendingBook(queue, 'unrecognized filename.epub') === qA, 'unmatched falls back to FIFO head');
  console.assert(queue.length === 1 && queue[0] === qC, 'fallback removed the head', queue);
  console.assert(takePendingBook([], 'anything.epub') === undefined, 'empty queue');
  console.log('parse.js self-check OK');
}
