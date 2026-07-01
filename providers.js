'use strict';
// Track download success/fail per provider (the bot that serves the file).
// Persisted as JSON so the record survives restarts. Display-only for now —
// does NOT affect result ranking yet.
const store = require('./store').open('PROVIDER_STATS', 'providers.json');

function record(stats, provider, ok) {
  const s = stats[provider] || (stats[provider] = { ok: 0, fail: 0 });
  if (ok) s.ok++; else s.fail++;
  store.save(stats);
  return s;
}

// Compact inline tag for the results list, e.g. "✓3 ✗1". Empty if unseen.
function tag(stats, provider) {
  const s = stats[provider];
  if (!s || (!s.ok && !s.fail)) return '';
  return `✓${s.ok} ✗${s.fail}`;
}

module.exports = { load: store.load, record, tag };

if (require.main === module) {
  const s = {};
  record(s, 'Oatmeal', true); record(s, 'Oatmeal', true); record(s, 'Oatmeal', false);
  console.assert(s.Oatmeal.ok === 2 && s.Oatmeal.fail === 1, 'counts', JSON.stringify(s));
  console.assert(tag(s, 'Oatmeal') === '✓2 ✗1', 'tag', tag(s, 'Oatmeal'));
  console.assert(tag(s, 'Never') === '', 'unseen tag');
  require('fs').unlinkSync(store.file); // clean the file this test just wrote
  console.log('providers.js self-check OK');
}
