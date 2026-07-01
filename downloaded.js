'use strict';
// Track which (provider, book) pairs have already been successfully
// downloaded. Scoped to provider deliberately, not just author+title: a title
// match across providers would mark a row green just because a *different*
// provider succeeded once, even for a provider that's only ever failed for
// this exact book. Persisted as JSON so it survives restarts.
const store = require('./store').open('DOWNLOADED_FILE', 'downloaded.json');

function key(provider, author, title) {
  return (provider + '::' + author + '::' + title).toLowerCase().trim();
}

function record(data, provider, author, title) {
  data[key(provider, author, title)] = true;
  store.save(data);
}

function has(data, provider, author, title) {
  return !!data[key(provider, author, title)];
}

module.exports = { load: store.load, record, has };

if (require.main === module) {
  const s = {};
  console.assert(!has(s, 'Bsk', 'Matt Dinniman', 'Operation Bounce House'), 'not downloaded yet');
  record(s, 'Bsk', 'Matt Dinniman', 'Operation Bounce House');
  console.assert(has(s, 'bsk', 'matt dinniman', 'OPERATION BOUNCE HOUSE'), 'case-insensitive match', s);
  console.assert(!has(s, 'Dumbledore', 'Matt Dinniman', 'Operation Bounce House'),
    'same title from a different provider is NOT marked downloaded');
  console.assert(!has(s, 'Bsk', 'Matt Dinniman', 'A Different Book'), 'distinct title not matched');
  require('fs').unlinkSync(store.file); // clean the file this test just wrote
  console.log('downloaded.js self-check OK');
}
