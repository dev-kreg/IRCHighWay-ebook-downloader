'use strict';
// DCC SEND receiver. IRC ebook bots send both search results and books via
// a CTCP "DCC SEND" offer, then listen on a TCP port; we connect and pull bytes.
// Library DCC layers are flaky with these bots, so we do it directly.
const net = require('net');
const fs = require('fs');
const path = require('path');

// Parse: DCC SEND <filename> <ip-as-uint32> <port> <filesize>
// filename may be quoted (spaces) or bare (spaces replaced with underscores).
function parseOffer(msg) {
  const m = msg.match(/^DCC SEND (?:"([^"]+)"|(\S+)) (\d+) (\d+) (\d+)/i);
  if (!m) return null;
  const filename = m[1] || m[2];
  const ipInt = Number(m[3]);
  const ip = [(ipInt >>> 24) & 255, (ipInt >>> 16) & 255, (ipInt >>> 8) & 255, ipInt & 255].join('.');
  return { filename: path.basename(filename), ip, port: Number(m[4]), size: Number(m[5]) };
}

// Connect to the offering bot and stream the file to destDir.
// onProgress(received, total) called as bytes arrive. Returns Promise<filepath>.
function receive(offer, destDir, onProgress) {
  return new Promise((resolve, reject) => {
    const dest = path.join(destDir, offer.filename);
    fs.mkdirSync(destDir, { recursive: true });
    const out = fs.createWriteStream(dest);
    let received = 0;
    const sock = net.connect(offer.port, offer.ip);
    // ponytail: 60s idle timeout; ebook bots stall silently on dead offers.
    sock.setTimeout(60000);

    sock.on('data', (chunk) => {
      out.write(chunk);
      received += chunk.length;
      // Ack total bytes received as 4-byte big-endian. Most bots ignore it
      // (turbo DCC), but well-behaved ones wait for it. Wraps past 4GB — fine.
      const ack = Buffer.alloc(4);
      ack.writeUInt32BE(received >>> 0, 0);
      sock.write(ack);
      if (onProgress) onProgress(received, offer.size);
      if (offer.size && received >= offer.size) sock.end();
    });
    // Failed transfers must not leave a truncated file at dest looking like a
    // good download — drop it along with rejecting.
    const fail = (err) => { out.destroy(); fs.unlink(dest, () => {}); reject(err); };
    sock.on('timeout', () => { sock.destroy(); fail(new Error('DCC timeout: ' + offer.filename)); });
    sock.on('error', fail);
    sock.on('close', () => {
      out.end(() => {
        if (offer.size && received < offer.size) fail(new Error(`incomplete: ${received}/${offer.size} bytes`));
        else resolve(dest);
      });
    });
  });
}

module.exports = { parseOffer, receive };

// ponytail: skipped passive/reverse DCC (port 0) and RESUME. irchighway
// SearchBot + book bots use active DCC; add if a bot offers port 0.
if (require.main === module) {
  const o = parseOffer('DCC SEND "Author - Book.epub" 3232235555 5000 12345');
  console.assert(o.ip === '192.168.0.35', 'ip decode', o.ip);
  console.assert(o.port === 5000 && o.size === 12345 && o.filename === 'Author - Book.epub', 'fields', o);
  console.assert(parseOffer('DCC SEND book.zip 16909060 1 9') !== null, 'bare filename');
  console.assert(parseOffer('DCC CHAT foo') === null, 'reject non-SEND');
  console.log('dcc.js self-check OK');
}
