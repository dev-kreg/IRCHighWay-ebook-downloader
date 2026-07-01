'use strict';
// blessed TUI: search box (top), results list (middle), status/log (bottom).
// Emits 'search' (query string) and 'select' ({cmd,label}) via callbacks set by
// the caller. Keyboard-driven: type in box + Enter to search, arrows + Enter on
// a result to download, Tab to move focus, q to quit (Ctrl-C intentionally does nothing).
const blessed = require('blessed');

function createUI({ onSearch, onSelect, onQuit }) {
  const screen = blessed.screen({ smartCSR: true, title: 'IRC Ebook Downloader' });

  const SEARCH_LABEL = ' Search (Enter to submit) ';
  const input = blessed.textbox({
    top: 0, left: 0, width: '100%', height: 3,
    border: 'line', label: SEARCH_LABEL,
    inputOnFocus: true, keys: true,
  });

  const RESULTS_LABEL = ' Results (↑↓ + Enter to download, Tab for search) ';
  const list = blessed.list({
    top: 3, left: 0, width: '100%', bottom: 6,
    border: 'line', label: RESULTS_LABEL,
    keys: true, vi: true, mouse: true, tags: true,
    style: { selected: { bg: 'blue', fg: 'white' }, item: { fg: 'white' } },
    scrollbar: { ch: ' ', style: { bg: 'grey' } },
  });

  const log = blessed.log({
    left: 0, bottom: 0, width: '100%', height: 6,
    border: 'line', label: ' Status ', tags: true, mouse: true,
    scrollback: 500, scrollbar: { ch: ' ', style: { bg: 'grey' } },
  });

  screen.append(input);
  screen.append(list);
  screen.append(log);

  // blessed hardcodes a wheel step of 2 (list.js: select(selected ± 2)); replace
  // with single-step so the scrollwheel moves one result at a time.
  list.removeAllListeners('element wheeldown');
  list.removeAllListeners('element wheelup');
  list.on('element wheeldown', () => { list.down(1); screen.render(); });
  list.on('element wheelup', () => { list.up(1); screen.render(); });

  let results = [];
  let waveTimer = null;
  function stopWave() { if (waveTimer) { clearInterval(waveTimer); waveTimer = null; } }

  // Spinner in the search box label while waiting for the bot's results.
  const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinTimer = null;
  function setSearching(on) {
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
    if (on) {
      let i = 0;
      spinTimer = setInterval(() => {
        input.setLabel(' ' + SPIN[i++ % SPIN.length] + ' Searching… ');
        screen.render();
      }, 100);
    } else {
      input.setLabel(SEARCH_LABEL);
      screen.render();
    }
  }

  input.on('submit', (value) => {
    const q = (value || '').trim();
    input.clearValue();
    // Don't refocus the input here: inputOnFocus would re-grab all keypresses
    // and the results list would never receive arrow keys. Tab returns here.
    screen.render();
    if (q) onSearch(q);
  });

  list.on('select', (_item, index) => {
    if (results[index]) onSelect(results[index]);
  });

  // Satisfying completion cue: a single green pulse on the results box — border
  // goes green with a "✓ N results" label, then settles back after a beat.
  let flashTimer = null;
  function celebrate(count) {
    const border = list.style.border || (list.style.border = {});
    if (flashTimer) clearTimeout(flashTimer);
    border.fg = 'green';
    list.setLabel(' ✓ ' + count + ' results ');
    screen.render();
    flashTimer = setTimeout(() => {
      flashTimer = null;
      border.fg = undefined;
      list.setLabel(RESULTS_LABEL);
      screen.render();
    }, 900);
  }

  // Focus movement.
  screen.key(['tab'], () => {
    if (screen.focused === input) list.focus();
    else input.focus();
    screen.render();
  });
  screen.key(['q'], () => { onQuit(); });

  const api = {
    setSearching,
    setResults(items) {
      setSearching(false);
      results = items;
      list.setItems(items.map((r) => r.label));
      list.select(0);
      list.focus();
      screen.render();
      celebrate(items.length);
    },
    status(msg) {
      log.log('{grey-fg}' + new Date().toTimeString().slice(0, 8) + '{/} ' + msg);
      screen.render();
    },
    // A cyan highlight that sweeps across the row text — the "download starting"
    // cue, shown until the first bytes arrive (setRowProgress stops it).
    waveRow(item) {
      stopWave();
      const base = item.label.replace(/\{[^}]*\}/g, '');
      const win = 3;
      let p = 0;
      waveTimer = setInterval(() => {
        const idx = results.indexOf(item);
        if (idx < 0) { stopWave(); return; }
        if (p > base.length + win) p = 0; // loop the sweep
        const a = Math.max(0, p - win), b = Math.min(base.length, p);
        list.setItem(idx, base.slice(0, a) + '{cyan-bg}' + base.slice(a, b) + '{/}' + base.slice(b));
        screen.render();
        p++;
      }, 45);
    },
    // Download progress rendered as a background fill on the item's own row.
    setRowProgress(item, percent) {
      stopWave();
      const idx = results.indexOf(item);
      if (idx < 0) return; // row gone (e.g. a new search replaced the list)
      const width = Math.max(10, (list.width | 0) - 3); // minus borders + scrollbar
      const base = item.label.replace(/\{[^}]*\}/g, ''); // strip tags; bg fill can't nest them
      const text = base.length >= width ? base.slice(0, width) : base + ' '.repeat(width - base.length);
      const fill = Math.min(width, Math.max(0, Math.round((width * percent) / 100)));
      list.setItem(idx, '{green-bg}' + text.slice(0, fill) + '{/}' + text.slice(fill));
      screen.render();
    },
    // Final outcome shown in the row: ✓ (saved) or ✗ (failed), restoring the label.
    setRowResult(item, ok) {
      stopWave();
      const idx = results.indexOf(item);
      if (idx < 0) return;
      list.setItem(idx, (ok ? '{green-fg}✓{/} ' : '{red-fg}✗{/} ') + item.label);
      screen.render();
    },
    focusSearch() { input.focus(); screen.render(); },
    destroy() { screen.destroy(); },
  };

  input.focus();
  screen.render();
  return api;
}

module.exports = { createUI };
