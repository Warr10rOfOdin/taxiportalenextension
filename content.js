// ============================================================
//  Voss Taxi Wallboard — Content Script  v1.4
//  Reads booking data from Taxiportalen DOM and renders a
//  dark-mode dispatch wallboard overlay.
// ============================================================

(function () {
  'use strict';

  // ----------------------------------------------------------
  //  Constants
  // ----------------------------------------------------------
  const POLL_INTERVAL_MS = 4000;
  const SCROLL_IDLE_MS = 45000;
  const UNDER_SENDING_CHIME_MS = 30000;
  const UPCOMING_MINUTES = 5;
  const TIME_WINDOW_HOURS = 24;
  const UTROP_BUCKET_SIZE = 5;
  const MUTATION_DEBOUNCE_MS = 300;
  const BADGE_UPDATE_MS = 5000;

  // Recognised column names → normalised keys
  const COLUMN_MAP = {
    'FAKTURNR': 'fakturnr',
    'REKVIRENT': 'rekvirent',
    'TAXI': 'taxi',
    'STATUS': 'status',
    'UTROP': 'utrop',
    'OPPMØTE': 'oppmote',
    'OPPMOTE': 'oppmote',
    'BEHANDLINGSTID': 'behandlingstid',
    'FRA': 'fra',
    'TIL': 'til',
    'NAVN': 'navn',
    'MELDING TIL BIL': 'meldingTilBil',
    'MELDINGTILBIL': 'meldingTilBil',
    'BET': 'bet',
    'REF': 'ref',
    'ALTTURID': 'altturid',
    'TLF': 'tlf',
    'EGENSKAP': 'egenskap',
    'TURID': 'turid',
    'INTERNNR': 'internnr',
  };

  const COMPLETED_STATUSES = new Set([
    'JA-SVAR',
    'KLAR FOR FAKTURERING',
    'KONTANT',
    'KREDITT',
  ]);

  const STATUS_CSS = {
    'UNDER SENDING': 'under-sending',
    'JA-SVAR': 'ja-svar',
    'KLAR FOR FAKTURERING': 'klar-fakturering',
    'KONTANT': 'kontant',
    'KREDITT': 'kreditt',
    'ENDRET': 'endret',
    'BEH.MANUELT': 'beh-manuelt',
    'ADD-ONS': 'add-ons',
  };

  // Column definitions for the overlay table (compact — details on click)
  const TABLE_COLUMNS = [
    { key: 'utrop',        label: 'UTROP',          sortKey: 'utrop'         },
    { key: 'oppmote',      label: 'OPPMOTE',        sortKey: 'oppmote'       },
    { key: 'taxi',         label: 'TAXI',           sortKey: 'taxi'          },
    { key: 'navn',         label: 'NAVN',           sortKey: 'navn'          },
    { key: 'fra',          label: 'FRA',            sortKey: 'fra'           },
    { key: 'til',          label: 'TIL',            sortKey: 'til'           },
    { key: 'status',       label: 'STATUS',         sortKey: 'status'        },
  ];

  const WEEKDAYS_NO = ['Sondag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lordag'];
  const MONTHS_NO = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];

  // ----------------------------------------------------------
  //  State
  // ----------------------------------------------------------
  let bookings = [];
  let previousBookingIds = new Set();
  let previousBookingsJSON = '';
  let chimePlayed = new Set();
  let lastScrollTime = Date.now();
  let overlayVisible = true;
  let muted = false;
  let searchQuery = '';
  let activeFilter = 'all';
  let underSendingInterval = null;
  let mutationTimer = null;
  let lastParseTime = 0;
  let parseCount = 0;
  let tableFound = false;
  let expandedRowId = null;
  let sortColumn = 'utrop';    // default sort
  let sortDirection = 'asc';   // asc | desc
  let isFullscreen = false;
  let debugVisible = false;
  let lastDiagnostics = null;

  // Consistent taxi number → color mapping
  const taxiColorCache = {};
  const TAXI_COLORS = [
    '#60a5fa', '#f87171', '#34d399', '#fbbf24', '#a78bfa',
    '#fb923c', '#38bdf8', '#f472b6', '#4ade80', '#e879f9',
    '#22d3ee', '#facc15', '#818cf8', '#fb7185', '#2dd4bf',
  ];

  // Audio context (created on first user interaction)
  let audioCtx = null;

  // ----------------------------------------------------------
  //  Helpers
  // ----------------------------------------------------------
  function now() { return new Date(); }

  function pad(n) { return String(n).padStart(2, '0'); }

  function formatTime24(date) {
    if (!(date instanceof Date) || isNaN(date)) return '\u2014';
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function formatFullTime24(date) {
    if (!(date instanceof Date) || isNaN(date)) return '\u2014';
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function formatDate(date) {
    return WEEKDAYS_NO[date.getDay()] + ' ' +
      date.getDate() + '. ' + MONTHS_NO[date.getMonth()] + ' ' +
      date.getFullYear();
  }

  function timeSince(ts) {
    if (!ts) return 'never';
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 5) return 'just now';
    if (secs < 60) return secs + 's ago';
    return Math.floor(secs / 60) + 'm ago';
  }

  function parseTimeString(str) {
    if (!str || typeof str !== 'string') return null;
    str = str.trim();
    // Try: "YYYY-MM-DD HH:MM(:SS)" (ISO format, used by Taxiportalen)
    let match = str.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (match) {
      return new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10),
        parseInt(match[4], 10), parseInt(match[5], 10), parseInt(match[6] || 0, 10));
    }
    // Try: "DD.MM.YYYY HH:MM(:SS)" (European format)
    match = str.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (match) {
      let year = parseInt(match[3], 10);
      if (year < 100) year += 2000;
      return new Date(year, parseInt(match[2], 10) - 1, parseInt(match[1], 10),
        parseInt(match[4], 10), parseInt(match[5], 10), parseInt(match[6] || 0, 10));
    }
    // Try: "HH:MM(:SS)"
    match = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (match) {
      const d = new Date();
      d.setHours(parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3] || 0, 10), 0);
      return d;
    }
    return null;
  }

  function bookingId(b) {
    return b.turid || b.fakturnr || [b.utropRaw, b.taxi, b.fra, b.navn].filter(Boolean).join('|');
  }

  function isWithinWindow(date) {
    if (!date) return true;
    const n = now();
    const lo = new Date(n.getTime() - TIME_WINDOW_HOURS * 3600000);
    const hi = new Date(n.getTime() + TIME_WINDOW_HOURS * 3600000);
    return date >= lo && date <= hi;
  }

  function isUpcoming(utropDate) {
    if (!utropDate) return false;
    const diff = utropDate.getTime() - now().getTime();
    return diff > 0 && diff <= UPCOMING_MINUTES * 60000;
  }

  function utropBucket(utropDate) {
    if (!utropDate) return null;
    const mins = utropDate.getHours() * 60 + utropDate.getMinutes();
    return Math.floor(mins / UTROP_BUCKET_SIZE) * UTROP_BUCKET_SIZE;
  }

  function currentBucket() {
    const n = now();
    const mins = n.getHours() * 60 + n.getMinutes();
    return Math.floor(mins / UTROP_BUCKET_SIZE) * UTROP_BUCKET_SIZE;
  }

  function esc(s) {
    if (!s) return '';
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  function escAttr(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatCountdown(utropDate) {
    if (!utropDate) return '';
    const diff = utropDate.getTime() - now().getTime();
    if (diff <= 0 || diff > UPCOMING_MINUTES * 60000) return '';
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return mins + ':' + pad(secs);
  }

  function taxiColor(taxiNum) {
    if (!taxiNum) return '';
    if (taxiColorCache[taxiNum]) return taxiColorCache[taxiNum];
    let hash = 0;
    for (let i = 0; i < taxiNum.length; i++) {
      hash = ((hash << 5) - hash) + taxiNum.charCodeAt(i);
      hash |= 0;
    }
    const color = TAXI_COLORS[Math.abs(hash) % TAXI_COLORS.length];
    taxiColorCache[taxiNum] = color;
    return color;
  }

  // ----------------------------------------------------------
  //  Audio — synthesised beeps (Web Audio API, no files)
  // ----------------------------------------------------------
  function ensureAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function playTone(freq, duration, type, delay) {
    if (muted) return;
    try {
      ensureAudioCtx();
      const startTime = audioCtx.currentTime + (delay || 0);
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
    } catch (_) { /* ignore audio errors */ }
  }

  function playUtropChime() {
    playTone(880, 0.15, 'sine', 0);
    playTone(1100, 0.22, 'sine', 0.16);
  }

  function playUnderSendingChime() {
    playTone(520, 0.2, 'triangle', 0);
    playTone(520, 0.2, 'triangle', 0.28);
    playTone(660, 0.3, 'triangle', 0.56);
  }

  function playNewBookingSound() {
    playTone(700, 0.08, 'sine', 0);
    playTone(900, 0.12, 'sine', 0.1);
  }

  // ----------------------------------------------------------
  //  DOM Parsing
  // ----------------------------------------------------------

  // Check if we are inside an iframe (sub-frame)
  const isSubFrame = window !== window.top;

  // Collect all accessible documents (main + same-origin iframes)
  function getAllDocuments() {
    const docs = [document];
    if (isSubFrame) return docs; // sub-frames only search their own document
    try {
      const iframes = document.querySelectorAll('iframe, frame');
      for (const iframe of iframes) {
        try {
          const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
          if (doc) docs.push(doc);
        } catch (_) { /* cross-origin, skip */ }
      }
    } catch (_) {}
    return docs;
  }

  function findBookingTableInDoc(doc) {
    const tables = doc.querySelectorAll('table');
    for (const t of tables) {
      // Skip our own overlay table
      if (t.id === 'vt-table') continue;
      // Check <thead> first, then first <tr>
      const thead = t.querySelector('thead');
      const headerRow = thead ? thead.querySelector('tr') : t.querySelector('tr');
      if (!headerRow) continue;
      const text = headerRow.textContent.toUpperCase();
      if (text.includes('TAXI') && text.includes('STATUS') && (text.includes('UTROP') || text.includes('FRA'))) {
        return { table: t, doc: doc };
      }
    }
    return null;
  }

  function findBookingTable() {
    const docs = getAllDocuments();
    for (const doc of docs) {
      const result = findBookingTableInDoc(doc);
      if (result) return result;
    }
    return null;
  }

  function findHeaderRow(table) {
    // Strategy 1: header in <thead>
    const thead = table.querySelector('thead');
    if (thead) {
      const row = thead.querySelector('tr');
      if (row) {
        const text = row.textContent.toUpperCase();
        if (text.includes('TAXI') || text.includes('STATUS')) return row;
      }
    }
    // Strategy 2: first <tr> with <th> cells
    const rows = table.querySelectorAll('tr');
    for (const row of rows) {
      if (row.querySelector('th')) {
        const text = row.textContent.toUpperCase();
        if (text.includes('TAXI') || text.includes('STATUS')) return row;
      }
    }
    // Strategy 3: first <tr> that contains known header text
    for (const row of rows) {
      const text = row.textContent.toUpperCase();
      if (text.includes('TAXI') && (text.includes('STATUS') || text.includes('UTROP') || text.includes('FRA'))) {
        return row;
      }
    }
    // Fallback: first row
    return rows[0] || null;
  }

  function mapHeaders(headerRow) {
    const map = {};
    const rawHeaders = [];
    const cells = headerRow.querySelectorAll('th, td');
    for (let i = 0; i < cells.length; i++) {
      const raw = (cells[i].textContent || '').trim().toUpperCase();
      rawHeaders.push(raw);
      // Prefer exact match first
      for (const [key, val] of Object.entries(COLUMN_MAP)) {
        if (raw === key) {
          map[val] = i;
        }
      }
    }
    // Then try includes match (only if not already mapped exactly)
    for (let i = 0; i < rawHeaders.length; i++) {
      const raw = rawHeaders[i];
      for (const [key, val] of Object.entries(COLUMN_MAP)) {
        if (map[val] !== undefined) continue; // already mapped by exact match
        if (raw.includes(key)) {
          map[val] = i;
        }
      }
    }
    // Store raw headers for diagnostics
    map._rawHeaders = rawHeaders;
    return map;
  }

  function getDataRows(table, headerRow) {
    const allRows = Array.from(table.querySelectorAll('tr'));
    // Find the header row index and return everything after it
    const headerIndex = allRows.indexOf(headerRow);
    if (headerIndex >= 0) {
      return allRows.slice(headerIndex + 1);
    }
    // If header is in <thead>, get rows from <tbody> or all non-header rows
    const tbody = table.querySelector('tbody');
    if (tbody) {
      return Array.from(tbody.querySelectorAll('tr'));
    }
    return allRows.slice(1);
  }

  function parseTable() {
    const found = findBookingTable();
    tableFound = !!(found && found.table);
    if (!found) return [];

    const { table } = found;
    const headerRow = findHeaderRow(table);
    if (!headerRow) return [];

    const dataRows = getDataRows(table, headerRow);
    if (dataRows.length === 0) return [];

    const headerMap = mapHeaders(headerRow);
    const results = [];

    // Track diagnostics
    let skippedEmpty = 0;
    let skippedFewCells = 0;
    let filteredByWindow = 0;
    const sampleRows = []; // first 3 rows for debug

    for (let r = 0; r < dataRows.length; r++) {
      const row = dataRows[r];
      const cells = row.querySelectorAll('td');
      // Accept rows with at least 2 cells (some tables have sparse rows)
      if (cells.length < 2) { skippedFewCells++; continue; }

      const get = (key) => {
        if (headerMap[key] !== undefined && cells[headerMap[key]]) {
          return (cells[headerMap[key]].textContent || '').trim();
        }
        return '';
      };

      const utropRaw = get('utrop');
      const oppmoteRaw = get('oppmote');
      const statusRaw = get('status');

      // Collect sample data for debugging (first 3 rows)
      if (sampleRows.length < 3) {
        sampleRows.push({
          cellCount: cells.length,
          utrop: utropRaw,
          oppmote: oppmoteRaw,
          status: statusRaw,
          taxi: get('taxi'),
          fra: get('fra'),
          navn: get('navn'),
          oppmoteParsed: parseTimeString(oppmoteRaw),
          utropParsed: parseTimeString(utropRaw),
        });
      }

      // Skip completely empty rows (no meaningful data)
      if (!utropRaw && !oppmoteRaw && !statusRaw && !get('taxi') && !get('fra') && !get('navn')) {
        skippedEmpty++;
        continue;
      }

      const booking = {
        fakturnr: get('fakturnr'),
        taxi: get('taxi'),
        status: statusRaw.toUpperCase(),
        utropRaw,
        utrop: parseTimeString(utropRaw),
        oppmoteRaw,
        oppmote: parseTimeString(oppmoteRaw),
        behandlingstid: get('behandlingstid'),
        fra: get('fra'),
        til: get('til'),
        navn: get('navn'),
        meldingTilBil: get('meldingTilBil'),
        bet: get('bet'),
        altturid: get('altturid'),
        tlf: get('tlf'),
        egenskap: get('egenskap'),
        turid: get('turid'),
      };

      booking.id = bookingId(booking);

      if (booking.oppmote && !isWithinWindow(booking.oppmote)) {
        filteredByWindow++;
        continue;
      }

      results.push(booking);
    }

    // Store diagnostics for debug panel
    lastDiagnostics = {
      headerCols: Object.keys(headerMap).filter(k => k !== '_rawHeaders').length,
      totalRows: dataRows.length,
      parsedRows: results.length,
      skippedEmpty,
      skippedFewCells,
      filteredByWindow,
      mappedColumns: headerMap,
      rawHeaders: headerMap._rawHeaders || [],
      sampleRows,
      currentTime: now().toISOString(),
    };

    lastParseTime = Date.now();
    parseCount++;
    return results;
  }

  // ----------------------------------------------------------
  //  Sorting & Grouping
  // ----------------------------------------------------------
  function compareValues(a, b, key, dir) {
    let va, vb;
    if (key === 'utrop') {
      va = a.utrop ? a.utrop.getTime() : Infinity;
      vb = b.utrop ? b.utrop.getTime() : Infinity;
    } else if (key === 'oppmote') {
      va = a.oppmote ? a.oppmote.getTime() : Infinity;
      vb = b.oppmote ? b.oppmote.getTime() : Infinity;
    } else {
      va = (a[key] || '').toLowerCase();
      vb = (b[key] || '').toLowerCase();
    }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  }

  function sortBookings(list) {
    list.sort((a, b) => compareValues(a, b, sortColumn, sortDirection));

    // Group ALTTURID siblings adjacent
    const grouped = [];
    const placed = new Set();
    const altGroups = {};

    for (const b of list) {
      if (b.altturid) {
        if (!altGroups[b.altturid]) altGroups[b.altturid] = [];
        altGroups[b.altturid].push(b);
      }
    }

    for (const b of list) {
      if (placed.has(b.id)) continue;
      if (b.altturid && altGroups[b.altturid] && altGroups[b.altturid].length > 1) {
        for (const member of altGroups[b.altturid]) {
          if (!placed.has(member.id)) {
            grouped.push(member);
            placed.add(member.id);
          }
        }
      } else {
        grouped.push(b);
        placed.add(b.id);
      }
    }

    return grouped;
  }

  // ----------------------------------------------------------
  //  Filtering
  // ----------------------------------------------------------
  function filterBookings(list) {
    let filtered = list;

    if (activeFilter === 'active') {
      filtered = filtered.filter(b => !COMPLETED_STATUSES.has(b.status));
    } else if (activeFilter === 'sending') {
      filtered = filtered.filter(b => b.status === 'UNDER SENDING');
    } else if (activeFilter === 'upcoming') {
      filtered = filtered.filter(b => isUpcoming(b.utrop));
    } else if (activeFilter === 'completed') {
      filtered = filtered.filter(b => COMPLETED_STATUSES.has(b.status));
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(b =>
        (b.taxi && b.taxi.toLowerCase().includes(q)) ||
        (b.navn && b.navn.toLowerCase().includes(q)) ||
        (b.fra && b.fra.toLowerCase().includes(q)) ||
        (b.til && b.til.toLowerCase().includes(q)) ||
        (b.tlf && b.tlf.includes(q)) ||
        (b.status && b.status.toLowerCase().includes(q)) ||
        (b.meldingTilBil && b.meldingTilBil.toLowerCase().includes(q)) ||
        (b.altturid && b.altturid.includes(q)) ||
        (b.fakturnr && b.fakturnr.includes(q))
      );
    }

    return filtered;
  }

  // ----------------------------------------------------------
  //  Row classification
  // ----------------------------------------------------------
  function isFutureTrip(booking) {
    // Trip hasn't happened yet — utrop is in the future
    if (booking.utrop && booking.utrop.getTime() > now().getTime()) return true;
    if (booking.oppmote && booking.oppmote.getTime() > now().getTime()) return true;
    return false;
  }

  function rowClass(booking) {
    if (booking.status === 'UNDER SENDING') return 'vt-row--sending';
    if (isUpcoming(booking.utrop)) return 'vt-row--upcoming';
    if (booking.status === 'ENDRET') return 'vt-row--changed';
    if (booking.status === 'BEH.MANUELT') return 'vt-row--manual';
    // Future trips with completed status are still shown as active
    if (COMPLETED_STATUSES.has(booking.status) && !isFutureTrip(booking)) return 'vt-row--completed';
    return 'vt-row--active';
  }

  function statusBadgeClass(status) {
    return STATUS_CSS[status] || 'default';
  }

  // ----------------------------------------------------------
  //  Build Overlay DOM
  // ----------------------------------------------------------
  function createOverlay() {
    // Toggle button
    const toggle = document.createElement('button');
    toggle.id = 'vt-toggle-btn';
    toggle.textContent = 'VT';
    toggle.title = 'Toggle Voss Taxi Wallboard (Escape)';
    toggle.addEventListener('click', () => {
      toggleOverlay();
      ensureAudioCtx();
    });
    document.body.appendChild(toggle);

    // Scroll indicator
    const scrollInd = document.createElement('div');
    scrollInd.id = 'vt-scroll-indicator';
    scrollInd.textContent = 'Auto-scroll paused';
    document.body.appendChild(scrollInd);

    // Sort options for the sort dropdown
    const SORT_OPTIONS = [
      { key: 'utrop', label: 'Utrop' },
      { key: 'oppmote', label: 'Oppmote' },
      { key: 'taxi', label: 'Taxi' },
      { key: 'status', label: 'Status' },
      { key: 'fra', label: 'Fra' },
      { key: 'navn', label: 'Navn' },
    ];
    let sortOptionsHtml = '';
    for (const opt of SORT_OPTIONS) {
      sortOptionsHtml += '<option value="' + opt.key + '"' +
        (sortColumn === opt.key ? ' selected' : '') + '>' + opt.label + '</option>';
    }

    // Main wallboard
    const wb = document.createElement('div');
    wb.id = 'vt-wallboard';
    wb.innerHTML =
      '<div id="vt-header">' +
        '<div id="vt-header-left">' +
          '<div id="vt-logo">Voss <span>Taxi</span> Wallboard</div>' +
          '<div id="vt-status-indicator" class="vt-indicator--searching" title="Connection status">' +
            '<span class="vt-indicator-dot"></span>' +
            '<span class="vt-indicator-text">Searching...</span>' +
          '</div>' +
          '<div id="vt-last-update" title="Last data refresh"></div>' +
        '</div>' +
        '<div id="vt-header-right">' +
          '<div id="vt-date"></div>' +
          '<div id="vt-clock">00:00:00</div>' +
        '</div>' +
      '</div>' +
      '<div id="vt-stats"></div>' +
      '<div id="vt-filter-bar">' +
        '<input type="text" id="vt-search" placeholder="Search... (Ctrl+F)" autocomplete="off" />' +
        '<button class="vt-filter-btn active" data-filter="all">All</button>' +
        '<button class="vt-filter-btn" data-filter="active">Active</button>' +
        '<button class="vt-filter-btn" data-filter="sending">Sending</button>' +
        '<button class="vt-filter-btn" data-filter="upcoming">Upcoming</button>' +
        '<button class="vt-filter-btn" data-filter="completed">Done</button>' +
        '<span class="vt-sort-wrap">' +
          '<label for="vt-sort-select" class="vt-sort-label">Sort:</label>' +
          '<select id="vt-sort-select">' + sortOptionsHtml + '</select>' +
          '<button id="vt-sort-dir" title="Toggle sort direction">' +
            (sortDirection === 'asc' ? '\u25b2' : '\u25bc') +
          '</button>' +
        '</span>' +
        '<button id="vt-mute-btn" title="Mute (M)">&#x1f50a;</button>' +
        '<button id="vt-fullscreen-btn" title="Fullscreen (F)">&#x26F6;</button>' +
        '<button id="vt-debug-btn" title="Debug (D)">&#x1f41b;</button>' +
      '</div>' +
      '<div id="vt-debug-panel" style="display:none;"></div>' +
      '<div id="vt-cards-wrap">' +
        '<div id="vt-cards"></div>' +
        '<div id="vt-empty" style="display:none;">' +
          '<div id="vt-empty-icon">&#x1f697;</div>' +
          '<div>No bookings to display</div>' +
          '<div style="font-size:13px;color:#374151;">Waiting for data from Taxiportalen...</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(wb);

    // --- Event listeners ---

    // Search
    document.getElementById('vt-search').addEventListener('input', (e) => {
      searchQuery = e.target.value;
      renderTable();
    });

    // Filter buttons
    document.querySelectorAll('.vt-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeFilter = btn.dataset.filter;
        document.querySelectorAll('.vt-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderTable();
      });
    });

    // Sort controls
    document.getElementById('vt-sort-select').addEventListener('change', (e) => {
      sortColumn = e.target.value;
      renderTable();
    });
    document.getElementById('vt-sort-dir').addEventListener('click', () => {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      document.getElementById('vt-sort-dir').textContent = sortDirection === 'asc' ? '\u25b2' : '\u25bc';
      renderTable();
    });

    // Mute toggle
    document.getElementById('vt-mute-btn').addEventListener('click', toggleMute);

    // Fullscreen toggle
    document.getElementById('vt-fullscreen-btn').addEventListener('click', toggleFullscreen);

    // Debug toggle
    document.getElementById('vt-debug-btn').addEventListener('click', toggleDebug);

    // Mouse/scroll activity tracking — any movement resets idle timer
    const wrap = document.getElementById('vt-cards-wrap');
    wrap.addEventListener('scroll', () => {
      lastScrollTime = Date.now();
      document.getElementById('vt-scroll-indicator').classList.add('visible');
    });
    document.addEventListener('mousemove', () => {
      lastScrollTime = Date.now();
    });
    document.addEventListener('mousedown', () => {
      lastScrollTime = Date.now();
    });
    document.addEventListener('touchstart', () => {
      lastScrollTime = Date.now();
    });

    // Card click for detail expansion (delegated)
    document.getElementById('vt-cards').addEventListener('click', (e) => {
      const card = e.target.closest('.vt-card[data-id]');
      if (!card) return;
      const id = card.getAttribute('data-id');
      expandedRowId = expandedRowId === id ? null : id;
      renderTable();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        if (e.key === 'Escape') {
          e.target.blur();
          e.preventDefault();
        }
        return;
      }

      if (e.key === 'Escape') {
        if (expandedRowId) {
          expandedRowId = null;
          renderTable();
        } else {
          toggleOverlay();
        }
        e.preventDefault();
      } else if (e.key === 'm' || e.key === 'M') {
        toggleMute();
        e.preventDefault();
      } else if (e.key === 'd' || e.key === 'D') {
        toggleDebug();
        e.preventDefault();
      } else if (e.key === 'f' && !e.ctrlKey && !e.metaKey) {
        toggleFullscreen();
        e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (overlayVisible) {
          const search = document.getElementById('vt-search');
          if (search) {
            search.focus();
            search.select();
            e.preventDefault();
          }
        }
      } else if (e.key === '1') {
        setFilter('all');
      } else if (e.key === '2') {
        setFilter('active');
      } else if (e.key === '3') {
        setFilter('sending');
      } else if (e.key === '4') {
        setFilter('upcoming');
      } else if (e.key === '5') {
        setFilter('completed');
      }
    });

    // Restore mute preference
    chrome.storage.local.get('vtMuted', (r) => {
      if (r.vtMuted) {
        muted = true;
        const btn = document.getElementById('vt-mute-btn');
        btn.classList.add('muted');
        btn.innerHTML = '&#x1f507;';
      }
    });
  }

  function toggleOverlay() {
    overlayVisible = !overlayVisible;
    const wb = document.getElementById('vt-wallboard');
    if (wb) wb.classList.toggle('vt-hidden', !overlayVisible);
  }

  function toggleMute() {
    muted = !muted;
    const btn = document.getElementById('vt-mute-btn');
    btn.classList.toggle('muted', muted);
    btn.innerHTML = muted ? '&#x1f507; Muted' : '&#x1f50a; Sound';
    chrome.storage.local.set({ vtMuted: muted });
  }

  function toggleFullscreen() {
    const wb = document.getElementById('vt-wallboard');
    if (!wb) return;
    if (!document.fullscreenElement) {
      wb.requestFullscreen().catch(() => {});
      isFullscreen = true;
    } else {
      document.exitFullscreen().catch(() => {});
      isFullscreen = false;
    }
    const btn = document.getElementById('vt-fullscreen-btn');
    if (btn) btn.innerHTML = isFullscreen ? '&#x26F6; Exit' : '&#x26F6; Fullscreen';
  }

  function setFilter(name) {
    activeFilter = name;
    document.querySelectorAll('.vt-filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === name);
    });
    renderTable();
  }

  function toggleDebug() {
    debugVisible = !debugVisible;
    const panel = document.getElementById('vt-debug-panel');
    if (panel) {
      panel.style.display = debugVisible ? 'block' : 'none';
      if (debugVisible) renderDebugPanel();
    }
    const btn = document.getElementById('vt-debug-btn');
    if (btn) btn.classList.toggle('active', debugVisible);
  }

  function renderDebugPanel() {
    const panel = document.getElementById('vt-debug-panel');
    if (!panel || !debugVisible) return;

    const docs = getAllDocuments();
    const found = findBookingTable();

    let tablesInfo = '';
    let docIdx = 0;
    for (const doc of docs) {
      const tables = doc.querySelectorAll('table');
      const isIframe = doc !== document;
      tablesInfo += '<div style="margin-bottom:4px;"><strong>' +
        (isIframe ? 'iframe' : 'main') + ' doc:</strong> ' +
        tables.length + ' table(s)</div>';
      for (const t of tables) {
        const firstRow = t.querySelector('tr');
        const cellCount = firstRow ? firstRow.querySelectorAll('th, td').length : 0;
        const rowCount = t.querySelectorAll('tr').length;
        const headerText = firstRow ? firstRow.textContent.trim().substring(0, 100) : '(empty)';
        const hasThead = !!t.querySelector('thead');
        const hasTbody = !!t.querySelector('tbody');
        tablesInfo += '<div style="font-size:11px;color:#6b7a94;margin-left:12px;margin-bottom:2px;">' +
          rowCount + ' rows, ' + cellCount + ' cols' +
          (hasThead ? ', &lt;thead&gt;' : '') +
          (hasTbody ? ', &lt;tbody&gt;' : '') +
          ' — header: "' + esc(headerText) + '"</div>';
      }
      docIdx++;
    }

    let diagHtml = '';
    if (lastDiagnostics) {
      const d = lastDiagnostics;
      diagHtml = '<div style="margin-top:8px;"><strong>Last parse:</strong> ' +
        d.headerCols + ' mapped cols, ' +
        d.totalRows + ' data rows, ' +
        d.parsedRows + ' parsed, ' +
        d.skippedFewCells + ' few-cells, ' +
        d.skippedEmpty + ' empty, ' +
        '<span style="color:' + (d.filteredByWindow > 0 ? '#f87171' : '#86efac') + ';">' +
        d.filteredByWindow + ' filtered-by-window</span></div>';

      diagHtml += '<div style="font-size:11px;color:#6b7a94;margin-top:2px;">' +
        'Current time: ' + esc(d.currentTime) + '</div>';

      diagHtml += '<div style="font-size:11px;color:#6b7a94;margin-top:2px;">' +
        'Raw headers: [' + esc(d.rawHeaders.join(' | ')) + ']</div>';

      diagHtml += '<div style="font-size:11px;color:#6b7a94;margin-top:2px;">' +
        'Mapped: ' + esc(Object.keys(d.mappedColumns).filter(k => k !== '_rawHeaders').join(', ')) + '</div>';

      if (d.sampleRows && d.sampleRows.length > 0) {
        diagHtml += '<div style="margin-top:6px;"><strong>Sample rows (first 3):</strong></div>';
        for (let i = 0; i < d.sampleRows.length; i++) {
          const s = d.sampleRows[i];
          const parsedOpp = s.oppmoteParsed ? s.oppmoteParsed.toISOString() : 'null';
          const parsedUtr = s.utropParsed ? s.utropParsed.toISOString() : 'null';
          const inWindow = s.oppmoteParsed ? isWithinWindow(s.oppmoteParsed) : 'N/A (null)';
          diagHtml += '<div style="font-size:11px;color:#6b7a94;margin-left:12px;margin-bottom:2px;">' +
            'Row ' + (i + 1) + ': ' + s.cellCount + ' cells | ' +
            'taxi=' + esc(s.taxi) + ' | ' +
            'status=' + esc(s.status) + ' | ' +
            'utrop="' + esc(s.utrop) + '"→' + esc(parsedUtr) + ' | ' +
            'oppmote="' + esc(s.oppmote) + '"→' + esc(parsedOpp) +
            ' | inWindow=' + inWindow +
            '</div>';
        }
      }
    }

    const iframes = document.querySelectorAll('iframe, frame');

    panel.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px;">Diagnostics</div>' +
      '<div>Table found: <strong>' + (found ? 'YES' : 'NO') + '</strong></div>' +
      '<div>Bookings parsed: <strong>' + bookings.length + '</strong></div>' +
      '<div>Parse count: ' + parseCount + '</div>' +
      '<div>Documents scanned: ' + docs.length + '</div>' +
      '<div>Iframes on page: ' + iframes.length + '</div>' +
      '<div>Is sub-frame: ' + isSubFrame + '</div>' +
      '<div style="margin-top:6px;"><strong>Tables:</strong></div>' +
      tablesInfo +
      diagHtml;
  }

  // ----------------------------------------------------------
  //  Render
  // ----------------------------------------------------------
  function renderStats(displayed) {
    const total = displayed.length;
    const sending = displayed.filter(b => b.status === 'UNDER SENDING').length;
    const upcoming = displayed.filter(b => isUpcoming(b.utrop)).length;
    const active = displayed.filter(b =>
      !COMPLETED_STATUSES.has(b.status) && b.status !== 'UNDER SENDING'
    ).length;
    const completed = displayed.filter(b => COMPLETED_STATUSES.has(b.status)).length;

    document.getElementById('vt-stats').innerHTML =
      '<div class="vt-stat vt-stat--total"><span class="vt-stat-dot"></span><span class="vt-stat-value">' + total + '</span><span>Total</span></div>' +
      '<div class="vt-stat vt-stat--sending"><span class="vt-stat-dot"></span><span class="vt-stat-value">' + sending + '</span><span>Under Sending</span></div>' +
      '<div class="vt-stat vt-stat--upcoming"><span class="vt-stat-dot"></span><span class="vt-stat-value">' + upcoming + '</span><span>Upcoming</span></div>' +
      '<div class="vt-stat vt-stat--active"><span class="vt-stat-dot"></span><span class="vt-stat-value">' + active + '</span><span>Active</span></div>' +
      '<div class="vt-stat vt-stat--completed"><span class="vt-stat-dot"></span><span class="vt-stat-value">' + completed + '</span><span>Completed</span></div>';
  }

  function updateStatusIndicator() {
    const el = document.getElementById('vt-status-indicator');
    if (!el) return;

    if (!tableFound) {
      el.className = 'vt-indicator--searching';
      el.querySelector('.vt-indicator-text').textContent = 'Searching for table...';
    } else if (bookings.length === 0) {
      el.className = 'vt-indicator--empty';
      el.querySelector('.vt-indicator-text').textContent = 'Table found, no data';
    } else {
      el.className = 'vt-indicator--connected';
      el.querySelector('.vt-indicator-text').textContent = 'Live \u2014 ' + bookings.length + ' bookings';
    }

    const upd = document.getElementById('vt-last-update');
    if (upd && lastParseTime) {
      upd.textContent = 'Updated ' + timeSince(lastParseTime);
    }
  }

  function buildCard(b, classes, statusSlug, groupBadge, countdownHtml, taxiStyle) {
    // Optional detail fields
    let details = '';
    const extras = [];
    if (b.tlf) extras.push(esc(b.tlf));
    if (b.egenskap) extras.push(esc(b.egenskap));
    if (b.behandlingstid) extras.push(esc(b.behandlingstid));
    if (b.bet) extras.push(esc(b.bet));

    const extrasHtml = extras.length > 0
      ? '<div class="vt-card-extras">' + extras.join(' &middot; ') + '</div>'
      : '';

    const meldingHtml = b.meldingTilBil
      ? '<div class="vt-card-melding" title="' + escAttr(b.meldingTilBil) + '">' + esc(b.meldingTilBil) + '</div>'
      : '';

    const altHtml = b.altturid
      ? '<span class="vt-card-alt">Alt:' + esc(b.altturid) + '</span>'
      : '';

    return '<div class="vt-card ' + classes + '" data-id="' + escAttr(b.id) + '">' +
      '<div class="vt-card-top">' +
        '<div class="vt-card-times">' +
          '<span class="vt-utrop-time">' + formatTime24(b.utrop) + '</span>' +
          '<span class="vt-time-arrow">\u2192</span>' +
          '<span class="vt-oppmote-time">' + formatTime24(b.oppmote) + '</span>' +
          countdownHtml +
        '</div>' +
        '<span class="vt-taxi-num"' + taxiStyle + '>' + esc(b.taxi) + '</span>' +
        groupBadge +
        '<span class="vt-status-badge vt-status--' + statusSlug + '">' + esc(b.status) + '</span>' +
      '</div>' +
      '<div class="vt-card-addr">' +
        '<div class="vt-card-fra"><span class="vt-addr-label">FRA</span> ' + esc(b.fra) + '</div>' +
        '<div class="vt-card-til"><span class="vt-addr-label">TIL</span> ' + esc(b.til) + '</div>' +
      '</div>' +
      '<div class="vt-card-bottom">' +
        '<span class="vt-card-navn">' + esc(b.navn) + '</span>' +
        extrasHtml +
        altHtml +
      '</div>' +
      meldingHtml +
    '</div>';
  }

  function renderTable() {
    const sorted = sortBookings([...bookings]);
    const displayed = filterBookings(sorted);

    renderStats(displayed);
    updateStatusIndicator();
    if (debugVisible) renderDebugPanel();

    const container = document.getElementById('vt-cards');
    const empty = document.getElementById('vt-empty');

    if (displayed.length === 0) {
      container.innerHTML = '';
      empty.style.display = 'flex';
      return;
    }
    empty.style.display = 'none';

    // Build ALTTURID group sets
    const altGroups = {};
    for (const b of displayed) {
      if (b.altturid) {
        if (!altGroups[b.altturid]) altGroups[b.altturid] = [];
        altGroups[b.altturid].push(b.id);
      }
    }

    const groupActive = {};
    for (const [aid, ids] of Object.entries(altGroups)) {
      if (ids.length <= 1) continue;
      groupActive[aid] = displayed.some(b =>
        b.altturid === aid && !COMPLETED_STATUSES.has(b.status)
      );
    }

    // Detect new bookings
    const currentIds = new Set(displayed.map(b => b.id));
    const newIds = new Set();
    if (previousBookingIds.size > 0) {
      for (const id of currentIds) {
        if (!previousBookingIds.has(id)) newIds.add(id);
      }
    }

    let html = '';
    for (let i = 0; i < displayed.length; i++) {
      const b = displayed[i];
      const isGrouped = b.altturid && altGroups[b.altturid] && altGroups[b.altturid].length > 1;
      const ids = isGrouped ? altGroups[b.altturid] : [];
      const isFirst = isGrouped && ids.indexOf(b.id) === 0;
      const isLast = isGrouped && ids.indexOf(b.id) === ids.length - 1;

      let rClass = rowClass(b);
      if (isGrouped && groupActive[b.altturid] && rClass === 'vt-row--completed') {
        rClass = 'vt-row--active';
      }

      let classes = rClass;
      if (isGrouped) classes += ' vt-group-member';
      if (isFirst) classes += ' vt-group-start';
      if (isLast) classes += ' vt-group-end';
      if (newIds.has(b.id)) classes += ' vt-card-new';
      classes += ' vt-card-enter';

      const statusSlug = statusBadgeClass(b.status);
      const groupBadge = isGrouped ? '<span class="vt-group-badge">G</span>' : '';

      const countdown = isUpcoming(b.utrop) ? formatCountdown(b.utrop) : '';
      const countdownHtml = countdown
        ? '<span class="vt-countdown">' + countdown + '</span>'
        : '';

      const tColor = taxiColor(b.taxi);
      const taxiStyle = tColor ? ' style="color:' + tColor + '"' : '';

      html += buildCard(b, classes, statusSlug, groupBadge, countdownHtml, taxiStyle);
    }

    container.innerHTML = html;
    previousBookingIds = currentIds;

    if (newIds.size > 0 && parseCount > 1) {
      playNewBookingSound();
    }
  }

  // ----------------------------------------------------------
  //  Clock
  // ----------------------------------------------------------
  function updateClock() {
    const n = now();
    const clockEl = document.getElementById('vt-clock');
    if (clockEl) {
      clockEl.textContent = pad(n.getHours()) + ':' + pad(n.getMinutes()) + ':' + pad(n.getSeconds());
    }
    const dateEl = document.getElementById('vt-date');
    if (dateEl) {
      dateEl.textContent = formatDate(n);
    }
    // Update "last updated" periodically
    const upd = document.getElementById('vt-last-update');
    if (upd && lastParseTime) {
      upd.textContent = 'Updated ' + timeSince(lastParseTime);
    }
  }

  // ----------------------------------------------------------
  //  Audio triggers
  // ----------------------------------------------------------
  function checkUtropChimes() {
    const cb = currentBucket();
    for (const b of bookings) {
      if (!b.utrop) continue;
      const bb = utropBucket(b.utrop);
      if (bb === cb && !chimePlayed.has(b.id)) {
        chimePlayed.add(b.id);
        playUtropChime();
        break;
      }
    }
  }

  function checkUnderSendingChime() {
    const hasSending = bookings.some(b => b.status === 'UNDER SENDING');
    if (hasSending && !underSendingInterval) {
      playUnderSendingChime();
      underSendingInterval = setInterval(() => {
        if (bookings.some(b => b.status === 'UNDER SENDING')) {
          playUnderSendingChime();
        } else {
          clearInterval(underSendingInterval);
          underSendingInterval = null;
        }
      }, UNDER_SENDING_CHIME_MS);
    } else if (!hasSending && underSendingInterval) {
      clearInterval(underSendingInterval);
      underSendingInterval = null;
    }
  }

  // ----------------------------------------------------------
  //  Badge update via messaging to service worker
  // ----------------------------------------------------------
  function updateBadge() {
    try {
      const sending = bookings.filter(b => b.status === 'UNDER SENDING').length;
      const upcoming = bookings.filter(b => isUpcoming(b.utrop)).length;
      chrome.runtime.sendMessage({
        type: 'vtBadgeUpdate',
        sendingCount: sending,
        upcomingCount: upcoming,
        totalCount: bookings.length,
      });
    } catch (_) { /* extension context may be invalidated */ }
  }

  // ----------------------------------------------------------
  //  Auto-scroll
  // ----------------------------------------------------------
  function checkAutoScroll() {
    if (Date.now() - lastScrollTime < SCROLL_IDLE_MS) return;

    const ind = document.getElementById('vt-scroll-indicator');
    if (ind) ind.classList.remove('visible');

    // Find first card whose booking is NOT "KLAR FOR FAKTURERING"
    const cards = document.querySelectorAll('#vt-cards .vt-card');
    let target = null;
    for (const card of cards) {
      const id = card.getAttribute('data-id');
      const booking = bookings.find(b => b.id === id);
      if (booking && booking.status !== 'KLAR FOR FAKTURERING') {
        target = card;
        break;
      }
    }
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ----------------------------------------------------------
  //  Main update loop
  // ----------------------------------------------------------
  function update() {
    const newBookings = parseTable();
    const json = JSON.stringify(newBookings.map(b => b.id + b.status));

    if (json !== previousBookingsJSON) {
      bookings = newBookings;
      previousBookingsJSON = json;
      renderTable();
      checkUnderSendingChime();
      updateBadge();
    }

    checkUtropChimes();
    checkAutoScroll();
    updateClock();
  }

  function debouncedUpdate() {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(update, MUTATION_DEBOUNCE_MS);
  }

  // ----------------------------------------------------------
  //  MutationObserver
  // ----------------------------------------------------------
  function setupObserver() {
    const found = findBookingTable();
    if (!found) return false;

    const observer = new MutationObserver(debouncedUpdate);
    observer.observe(found.table, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return true;
  }

  // ----------------------------------------------------------
  //  Initialisation
  // ----------------------------------------------------------
  function init() {
    // Sub-frames: only notify parent about table data, don't create overlay
    if (isSubFrame) {
      initSubFrame();
      return;
    }

    createOverlay();
    update();

    let observerReady = setupObserver();
    if (!observerReady) {
      const retryObs = setInterval(() => {
        observerReady = setupObserver();
        if (observerReady) {
          clearInterval(retryObs);
          update();
        }
      }, 2000);
    }

    setInterval(update, POLL_INTERVAL_MS);
    setInterval(updateClock, 1000);
    setInterval(checkAutoScroll, 5000);
    setInterval(updateBadge, BADGE_UPDATE_MS);
  }

  // Sub-frame: parse table and send data to parent via messaging
  function initSubFrame() {
    function sendToParent() {
      const data = parseTable();
      try {
        chrome.runtime.sendMessage({
          type: 'vtSubFrameData',
          bookings: data.map(b => ({
            ...b,
            utrop: b.utrop ? b.utrop.toISOString() : null,
            oppmote: b.oppmote ? b.oppmote.toISOString() : null,
          })),
          tableFound: tableFound,
        });
      } catch (_) {}
    }

    sendToParent();
    setupObserver();
    setInterval(sendToParent, POLL_INTERVAL_MS);
  }

  // ----------------------------------------------------------
  //  Message listener (for popup stats requests)
  // ----------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'vtGetStats') {
      const sending = bookings.filter(b => b.status === 'UNDER SENDING').length;
      const upcoming = bookings.filter(b => isUpcoming(b.utrop)).length;
      const completed = bookings.filter(b => COMPLETED_STATUSES.has(b.status)).length;
      sendResponse({
        total: bookings.length,
        sending,
        upcoming,
        completed,
      });
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
