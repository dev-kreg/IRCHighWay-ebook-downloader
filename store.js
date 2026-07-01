'use strict';
// Tiny JSON-backed store persisted under ~/.config/irc-ebook-dl. Shared
// scaffolding for providers.js and downloaded.js — open() returns load/save
// bound to one file; each module layers its own record/tag/has on top.
const fs = require('fs');
const path = require('path');
const os = require('os');

function open(envVar, filename) {
  const file = process.env[envVar] ||
    path.join(os.homedir(), '.config', 'irc-ebook-dl', filename);
  return {
    file,
    load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; } },
    save(data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    },
  };
}

module.exports = { open };
