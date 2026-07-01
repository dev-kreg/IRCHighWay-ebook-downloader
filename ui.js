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
    inputOnFocus: true, keys: true, mouse: true,
    // blessed's built-in click handling (screen.js: 'element click' -> el.focus())
    // calls focus() unconditionally on every click, bypassing our own guarded
    // click handler below and re-stacking a second readInput() listener. We
    // own focus-on-click ourselves, so opt out of the built-in one.
    autoFocus: false,
  });

  // Column header row, sitting above the (unbordered) results list.
  const header = blessed.box({
    top: 3, left: 0, width: '100%', height: 1,
    tags: true, style: { fg: 'grey' },
  });

  const RESULTS_LABEL = ' Results (↑↓+Enter to download, / to filter, Tab for search) ';
  const list = blessed.list({
    top: 4, left: 0, width: '100%', bottom: 12,
    border: 'line', label: RESULTS_LABEL,
    keys: true, vi: true, mouse: true, tags: true,
    style: { selected: { bg: 'blue', fg: 'white' }, item: { fg: 'white' } },
    scrollbar: { ch: ' ', style: { bg: 'grey' } },
  });

  // Extra-large "searching" indicator: a dot sweeping around a ring, centered
  // over the results area. Covers the (already-cleared) list while waiting.
  const spinnerBox = blessed.box({
    top: 4, left: 0, width: '100%', bottom: 12,
    align: 'center', valign: 'middle', tags: true, hidden: true,
  });

  // Queue-at-a-glance: everything requested but not yet resolved (✓/✗), so a
  // batch of downloads doesn't require scrolling the results list or reading
  // the raw log to see what's still in flight.
  const DOWNLOADS_LABEL = ' Active Downloads ';
  const downloadsPanel = blessed.box({
    bottom: 6, left: 0, width: '100%', height: 6,
    border: 'line', label: DOWNLOADS_LABEL, tags: true,
  });
  const SPIN_RING = [[0, 2], [0, 4], [2, 4], [4, 4], [4, 2], [4, 0], [2, 0], [0, 0]];
  let searchStep = ''; // latest SearchBot notice ("accepted", "returned N matches", ...)
  function bigSpinnerFrame(i) {
    const [pr, pc] = SPIN_RING[i % SPIN_RING.length];
    let out = '';
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) out += (r === pr && c === pc) ? '{yellow-fg}◆{/} ' : '  ';
      out += '\n';
    }
    out += '\n{bold}Searching…{/bold}';
    if (searchStep) out += '\n{grey-fg}' + searchStep + '{/}';
    return out;
  }

  const log = blessed.log({
    left: 0, bottom: 0, width: '100%', height: 6,
    border: 'line', label: ' Status ', tags: true, mouse: true,
    scrollback: 500, scrollbar: { ch: ' ', style: { bg: 'grey' } },
  });

  screen.append(input);
  screen.append(header);
  screen.append(list);
  screen.append(spinnerBox); // after list so it renders on top while searching
  screen.append(downloadsPanel);
  screen.append(log);

  // blessed hardcodes a wheel step of 2 (list.js: select(selected ± 2)); replace
  // with single-step so the scrollwheel moves one result at a time.
  list.removeAllListeners('element wheeldown');
  list.removeAllListeners('element wheelup');
  list.on('element wheeldown', () => { list.down(1); screen.render(); });
  list.on('element wheelup', () => { list.up(1); screen.render(); });

  let results = [];    // currently displayed rows (subset of allResults when filtered)
  let allResults = [];
  let filterText = '';

  // Every download this session, keyed by item so entries survive a new search
  // clearing the results list out from under them. Resolved ones stick around
  // (with their final status) instead of vanishing, so a batch's outcome is
  // still visible after the fact.
  const active = new Map();
  function statusCell(state) {
    const words = { queued: ['queued', 'grey-fg'], receiving: [Math.round(state.percent) + '%', 'yellow-fg'],
      done: ['done', 'green-fg'], failed: ['failed', 'red-fg'] };
    const [word, color] = words[state.status];
    return '{' + color + '}' + left(word, 8) + '{/}';
  }
  function renderDownloadsPanel() {
    const MAX_LINES = 4;
    if (!active.size) {
      downloadsPanel.setLabel(DOWNLOADS_LABEL);
      downloadsPanel.setContent('{grey-fg}(none){/}');
      screen.render();
      return;
    }
    const entries = [...active.entries()];
    const inFlight = entries.filter(([, s]) => s.status === 'queued' || s.status === 'receiving');
    const resolved = entries.filter(([, s]) => s.status === 'done' || s.status === 'failed').reverse();
    downloadsPanel.setLabel(' Active Downloads (' + inFlight.length + ' active, ' + entries.length + ' total) ');
    const ordered = [...inFlight, ...resolved]; // in-flight always visible; resolved fill remaining slots, newest first
    const lines = ordered.slice(0, MAX_LINES).map(([item, state]) =>
      statusCell(state) + ' ' + left(item.title || item.cmd, 32) + ' {grey-fg}' + (item.provider || '') + '{/}');
    if (ordered.length > MAX_LINES) lines.push('{grey-fg}+' + (ordered.length - MAX_LINES) + ' more{/}');
    downloadsPanel.setContent(lines.join('\n'));
    screen.render();
  }

  // Column layout: icon | Author | Title | Extras (fills leftover space) |
  // Size | Source(+stats). Size/Source are right-justified so numbers and
  // provider names line up flush on the right; Extras stretches to fill
  // whatever room is left based on the current terminal width.
  const ICON_W = 2, AUTHOR_W = 20, TITLE_W = 40, SIZE_W = 8, SOURCE_W = 12, STATS_W = 14;
  const GAPS = 5; // icon-author, author-title, title-extras, extras-size, size-source
  function left(s, w) {
    s = String(s || '');
    return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w);
  }
  function right(s, w) {
    s = String(s || '');
    return s.length > w ? '…' + s.slice(s.length - w + 1) : s.padStart(w);
  }
  function extrasWidth() {
    const avail = Math.max(10, (list.width | 0) - 3); // minus borders + scrollbar
    // STATS_W reserves room for the trailing "[✓N ✗N]" provider badge, which
    // is appended after Source with no column of its own — without this,
    // Extras filling 100% of the width pushes it off the visible edge.
    return Math.max(10, avail - (ICON_W + AUTHOR_W + TITLE_W + SIZE_W + SOURCE_W + STATS_W + GAPS));
  }
  function updateHeader() {
    header.setContent('{bold}  ' + left('Author', AUTHOR_W) + ' ' + left('Title', TITLE_W) + ' ' +
      left('Extras', extrasWidth()) + ' ' + right('Size', SIZE_W) + ' ' + right('Source', SOURCE_W) + '{/bold}');
  }

  // The row's leading 2-char icon slot: star for the top-scored result(s), or
  // blank. setRowResult swaps it for ✓/✗ without disturbing the columns after it.
  function formatRow(item) {
    return left(item.author, AUTHOR_W) + ' ' + left(item.title, TITLE_W) + ' ' +
      left(item.extras, extrasWidth()) + ' ' + right(item.sizeText, SIZE_W) + ' ' +
      right(item.provider, SOURCE_W) + (item.statsText || '');
  }
  function rowText(item) {
    const icon = item.top ? '{yellow-fg}★{/}' : ' ';
    return icon + ' ' + formatRow(item);
  }
  // Dark text on these light backgrounds — bg colors are the user's exact
  // requested values (red = failed, amber = queued/in-progress).
  const FILL_COLORS = {
    green: { fg: '#eafbea', bg: '#2f6b2f' },
    red: { fg: '#3a0000', bg: '#ff9494' },
    amber: { fg: '#3a2900', bg: '#ffbf00' },
  };
  // A solid full-row status highlight (tags stripped — a bg fill can't nest
  // color tags): amber = queued/in-progress, green = have/saved, red = failed.
  // Not a progress bar — the numeric percent lives in the Active Downloads
  // panel; the row just signals which state it's in.
  function fillRow(item, color) {
    const width = Math.max(10, (list.width | 0) - 3); // minus borders + scrollbar
    const base = rowText(item).replace(/\{[^}]*\}/g, '');
    const text = base.length >= width ? base.slice(0, width) : base + ' '.repeat(width - base.length);
    const c = FILL_COLORS[color];
    return '{' + c.fg + '-fg,' + c.bg + '-bg}' + text + '{/}';
  }

  function matchesFilter(r, needle) {
    return [r.author, r.title, r.extras, r.provider].some((v) => (v || '').toLowerCase().includes(needle));
  }

  // What a row should show right now: this session's own live outcome (set by
  // setRowProgress/setRowResult) takes priority over the historical
  // "downloaded before" flag — otherwise a re-render (filter, Esc, new search
  // reusing the same items) would repaint a just-failed row green again from
  // stale history.
  function styledRowText(item) {
    if (item.sessionResult === 'done') return fillRow(item, 'green');
    if (item.sessionResult === 'failed') return fillRow(item, 'red');
    if (item.sessionResult === 'active') return fillRow(item, 'amber'); // queued or receiving
    if (item.downloaded) return fillRow(item, 'green');
    return rowText(item);
  }
  // The list's own blue "selected" highlight is a base render style, but our
  // status fills are colors baked directly into the row's content — those win
  // over it. So: whichever row is currently selected always renders plain
  // (letting the selection highlight show through untouched); its real
  // styling is restored the moment selection moves elsewhere.
  function paintRow(idx, item) {
    if (idx < 0 || !item) return;
    list.setItem(idx, idx === list.selected ? rowText(item) : styledRowText(item));
  }
  let prevSelected = 0;
  list.on('select item', (_item, idx) => {
    if (prevSelected !== idx) paintRow(prevSelected, results[prevSelected]);
    paintRow(idx, results[idx]);
    prevSelected = idx;
    screen.render();
  });

  function applyFilter() {
    updateHeader();
    const needle = filterText.toLowerCase();
    results = needle ? allResults.filter((r) => matchesFilter(r, needle)) : allResults.slice();
    list.setItems(results.map((r) => styledRowText(r)));
    list.select(0);
    prevSelected = 0;
    paintRow(0, results[0]); // select(0) above may not have fired 'select item' if index 0 was already selected
    list.setLabel(filterText
      ? ' Results — filter "' + filterText + '" (' + results.length + '/' + allResults.length + '), Esc to clear '
      : RESULTS_LABEL);
    screen.render();
  }

  let spinTimer = null;
  let spinFrame = 0;
  function setSearching(on) {
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
    if (on) {
      searchStep = '';
      spinFrame = 0;
      input.setLabel(' Searching… ');
      spinnerBox.setContent(bigSpinnerFrame(spinFrame)); // avoid a stale frame flashing before the first tick
      spinnerBox.show();
      spinTimer = setInterval(() => {
        spinFrame++;
        spinnerBox.setContent(bigSpinnerFrame(spinFrame));
        screen.render();
      }, 100);
    } else {
      input.setLabel(SEARCH_LABEL);
      input.clearValue(); // query stayed visible during the search; clear now it's done
      spinnerBox.hide();
      screen.render();
    }
  }

  // blessed's inputOnFocus re-fires readInput() on every 'focus' event, even a
  // no-op refocus of the already-focused element — that stacks a second
  // concurrent input listener, so every keystroke lands twice. Guard it here
  // once rather than at each call site (click, focusSearch()).
  function focusInput() {
    if (screen.focused === input) return;
    input.focus();
  }

  // Clicking the search bar focuses it for typing, same as pressing Tab there.
  input.on('click', () => { focusInput(); screen.render(); });

  input.on('submit', (value) => {
    const q = (value || '').trim();
    // Leave the query visible (setSearching(false) clears it once results are
    // in) so it's still on screen while the big spinner is up. Don't refocus
    // the input here either: inputOnFocus would re-grab all keypresses and
    // the results list would never receive arrow keys. Tab returns here.
    screen.render();
    if (q) onSearch(q);
  });

  list.on('select', (_item, index) => {
    if (results[index]) onSelect(results[index]);
  });

  // '/' opens a small modal to narrow the current results by author/title/
  // extras/source text (client-side only, no new IRC search). Esc clears it.
  const filterPrompt = blessed.prompt({
    parent: screen, top: 'center', left: 'center', width: '60%', height: 8,
    border: 'line', label: ' Filter results ', tags: true, hidden: true,
  });
  list.key(['/'], () => {
    filterPrompt.input('Author / Title / Extras / Source contains:', filterText, (err, value) => {
      if (err || value == null) return; // cancelled
      filterText = value.trim();
      applyFilter();
      list.focus();
      screen.render();
    });
  });
  list.key(['escape'], () => {
    if (!filterText) return;
    filterText = '';
    applyFilter();
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
    // Surfaces each step the bot reports (accepted / searching / returned N
    // matches / ...) under the spinner, so progress is visible where you're
    // already looking instead of only scrolling by in the status log.
    setSearchStep(msg) {
      searchStep = msg;
      if (!spinTimer) return; // not searching right now; nothing to update
      spinnerBox.setContent(bigSpinnerFrame(spinFrame));
      screen.render();
    },
    setResults(items) {
      setSearching(false);
      allResults = items;
      filterText = '';
      applyFilter();
      list.focus();
      celebrate(items.length);
    },
    // A search came back with nothing to show — reuse the spinner's spot
    // (same place, mutually exclusive in time) for a static centered message
    // instead of leaving the results area blank.
    showEmpty(msg) {
      setSearching(false);
      spinnerBox.setContent('{yellow-fg}⚠{/}\n\n' + msg);
      spinnerBox.show();
      screen.render();
    },
    // Wipe the board immediately when a new search starts, so stale rows from
    // the previous search don't linger while the new one is in flight.
    clearResults() {
      allResults = [];
      filterText = '';
      results = [];
      list.setItems([]);
      list.setLabel(RESULTS_LABEL);
      screen.render();
    },
    status(msg) {
      log.log('{grey-fg}' + new Date().toTimeString().slice(0, 8) + '{/} ' + msg);
      screen.render();
    },
    // A download has been requested but no DCC offer has arrived yet — the row
    // goes amber immediately and stays amber for the whole active period.
    setRowQueued(item) {
      item.sessionResult = 'active';
      active.set(item, { status: 'queued', percent: 0 });
      renderDownloadsPanel();
      const idx = results.indexOf(item);
      if (idx >= 0) { list.setItem(idx, fillRow(item, 'amber')); screen.render(); }
    },
    // Progress updates the percent shown in the Active Downloads panel; the row
    // itself stays solid amber (already painted by setRowQueued) throughout.
    setRowProgress(item, percent) {
      item.sessionResult = 'active';
      active.set(item, { status: 'receiving', percent });
      renderDownloadsPanel();
      const idx = results.indexOf(item);
      if (idx < 0) return; // row gone (e.g. a new search replaced the list)
      // Always paint, selected or not: you select a row then hit Enter to
      // download it, so it's usually the selected row for the whole transfer.
      list.setItem(idx, fillRow(item, 'amber'));
      screen.render();
    },
    // Final outcome: the whole row fills — green for saved, red for failed —
    // instead of a small icon, so it reads at a glance across a whole batch.
    // Stays in the Active Downloads panel as done/failed rather than vanishing,
    // so a batch's outcome is still visible after the fact.
    setRowResult(item, ok) {
      item.sessionResult = ok ? 'done' : 'failed'; // outranks the historical "downloaded before" flag on re-render
      active.set(item, { status: ok ? 'done' : 'failed' });
      renderDownloadsPanel();
      const idx = results.indexOf(item);
      if (idx < 0) return;
      list.setItem(idx, fillRow(item, ok ? 'green' : 'red')); // live outcome always visible, same reasoning
      screen.render();
    },
    focusSearch() { focusInput(); screen.render(); },
    destroy() { screen.destroy(); },
  };

  input.focus();
  screen.render(); // list.width is only valid after layout runs on this first render
  updateHeader();
  renderDownloadsPanel();
  screen.render();
  return api;
}

module.exports = { createUI };
