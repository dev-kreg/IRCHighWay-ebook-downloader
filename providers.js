'use strict';
// Track download success/fail per provider (the bot that serves the file).
// Persisted as JSON so the record survives restarts. Display-only for now —
// does NOT affect result ranking yet.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = process.env.PROVIDER_STATS ||
  path.join(os.homedir(), '.config', 'irc-ebook-dl', 'providers.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; }
}

function save(stats) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(stats, null, 2));
}

function record(stats, provider, ok) {
  const s = stats[provider] || (stats[provider] = { ok: 0, fail: 0 });
  if (ok) s.ok++; else s.fail++;
  save(stats);
  return s;
}

// Compact inline tag for the results list, e.g. "✓3 ✗1". Empty if unseen.
function tag(stats, provider) {
  const s = stats[provider];
  if (!s || (!s.ok && !s.fail)) return '';
  return `✓${s.ok} ✗${s.fail}`;
}

module.exports = { load, record, tag };

if (require.main === module) {
  const s = {};
  record(s, 'Oatmeal', true); record(s, 'Oatmeal', true); record(s, 'Oatmeal', false);
  console.assert(s.Oatmeal.ok === 2 && s.Oatmeal.fail === 1, 'counts', JSON.stringify(s));
  console.assert(tag(s, 'Oatmeal') === '✓2 ✗1', 'tag', tag(s, 'Oatmeal'));
  console.assert(tag(s, 'Never') === '', 'unseen tag');
  fs.unlinkSync(FILE); // clean the file this test just wrote
  console.log('providers.js self-check OK');
}
