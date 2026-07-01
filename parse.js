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

// Provider = the serving bot, the first token: "!Oatmeal Author - ..." -> "Oatmeal".
function providerOf(cmd) {
  const m = cmd.match(/^!(\S+)/);
  return m ? m[1] : '';
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
function scoreResult(item) {
  let s = versionOf(item.label) * 10;
  if (/\bretail\b/i.test(item.label)) s += 5;
  const size = sizeOf(item.label);
  if (size) {
    if (size < 30 * 1024) s -= 5;              // <30KB: likely sample/broken
    else if (size <= 15 * 1024 ** 2) s += 2;   // 30KB–15MB: plausible epub
  }
  return s;
}

module.exports = {
  parseResultsZip, parseResultsText, isSupportedArchive, filterFormats,
  versionOf, providerOf, sizeOf, scoreResult,
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
  console.log('parse.js self-check OK');
}
