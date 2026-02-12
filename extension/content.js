// ============================================================
//  Voss Taxi Wallboard — Content Script
//  Reads booking data from Taxiportalen DOM and renders a
//  dark-mode dispatch wallboard overlay.
// ============================================================

(function () {
  'use strict';

  // ----------------------------------------------------------
  //  Constants
  // ----------------------------------------------------------
  const POLL_INTERVAL_MS = 4000;
  const SCROLL_IDLE_MS = 30000;
  const UNDER_SENDING_CHIME_MS = 30000;
  const UPCOMING_MINUTES = 5;
  const TIME_WINDOW_HOURS = 24;
  const UTROP_BUCKET_SIZE = 5;

  // Recognised column names → normalised keys
  const COLUMN_MAP = {
    'FAKTURNR': 'fakturnr',
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
    'BET': 'bet',
    'ALTTURID': 'altturid',
    'TLF': 'tlf',
    'EGENSKAP': 'egenskap',
    'TURID': 'turid',
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

  // ----------------------------------------------------------
  //  State
  // ----------------------------------------------------------
  let bookings = [];
  let previousBookingsJSON = '';
  let chimePlayed = new Set();       // booking ids that already chimed
  let lastScrollTime = Date.now();
  let overlayVisible = true;
  let muted = false;
  let searchQuery = '';
  let activeFilter = 'all';          // all | active | sending | upcoming | completed
  let underSendingInterval = null;

  // Audio context (created on first interaction)
  let audioCtx = null;

  // ----------------------------------------------------------
  //  Helpers
  // ----------------------------------------------------------
  function now() { return new Date(); }

  function pad(n) { return String(n).padStart(2, '0'); }

  function formatTime24(date) {
    if (!(date instanceof Date) || isNaN(date)) return '—';
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function parseTimeString(str) {
    if (!str || typeof str !== 'string') return null;
    str = str.trim();
    // Try multiple formats: "HH:MM", "HH:MM:SS", "DD.MM.YYYY HH:MM", etc.
    let match = str.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (match) {
      let year = parseInt(match[3], 10);
      if (year < 100) year += 2000;
      return new Date(year, parseInt(match[2], 10) - 1, parseInt(match[1], 10),
        parseInt(match[4], 10), parseInt(match[5], 10), parseInt(match[6] || 0, 10));
    }
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
    if (!date) return true; // keep if we can't parse
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

  // ----------------------------------------------------------
  //  Audio — synthesise beeps (no external files needed)
  // ----------------------------------------------------------
  function ensureAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function playTone(freq, duration, type) {
    if (muted) return;
    try {
      ensureAudioCtx();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (_) { /* ignore audio errors */ }
  }

  function playUtropChime() {
    playTone(880, 0.15, 'sine');
    setTimeout(() => playTone(1100, 0.2, 'sine'), 160);
  }

  function playUnderSendingChime() {
    playTone(520, 0.25, 'triangle');
    setTimeout(() => playTone(520, 0.25, 'triangle'), 300);
    setTimeout(() => playTone(660, 0.35, 'triangle'), 600);
  }

  // ----------------------------------------------------------
  //  DOM Parsing
  // ----------------------------------------------------------
  function findBookingTable() {
    // Find the main data table — look for a table with known header text
    const tables = document.querySelectorAll('table');
    for (const t of tables) {
      const firstRow = t.querySelector('tr');
      if (!firstRow) continue;
      const text = firstRow.textContent.toUpperCase();
      if (text.includes('TAXI') && text.includes('STATUS') && (text.includes('UTROP') || text.includes('FRA'))) {
        return t;
      }
    }
    return null;
  }

  function mapHeaders(headerRow) {
    const map = {};
    const cells = headerRow.querySelectorAll('th, td');
    for (let i = 0; i < cells.length; i++) {
      const raw = (cells[i].textContent || '').trim().toUpperCase();
      for (const [key, val] of Object.entries(COLUMN_MAP)) {
        if (raw === key || raw.includes(key)) {
          map[val] = i;
        }
      }
    }
    return map;
  }

  function parseTable() {
    const table = findBookingTable();
    if (!table) return [];

    const rows = table.querySelectorAll('tr');
    if (rows.length < 2) return [];

    const headerMap = mapHeaders(rows[0]);
    const results = [];

    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r].querySelectorAll('td');
      if (cells.length < 4) continue;

      const get = (key) => {
        if (headerMap[key] !== undefined && cells[headerMap[key]]) {
          return (cells[headerMap[key]].textContent || '').trim();
        }
        return '';
      };

      const utropRaw = get('utrop');
      const oppmoteRaw = get('oppmote');

      const booking = {
        fakturnr: get('fakturnr'),
        taxi: get('taxi'),
        status: get('status').toUpperCase(),
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

      // Filter by time window using oppmote
      if (booking.oppmote && !isWithinWindow(booking.oppmote)) continue;

      results.push(booking);
    }

    return results;
  }

  // ----------------------------------------------------------
  //  Sorting & Grouping
  // ----------------------------------------------------------
  function sortBookings(list) {
    // Primary: sort by UTROP ascending
    list.sort((a, b) => {
      const ta = a.utrop ? a.utrop.getTime() : Infinity;
      const tb = b.utrop ? b.utrop.getTime() : Infinity;
      return ta - tb;
    });

    // Group ALTTURID siblings together
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

    // Status filter
    if (activeFilter === 'active') {
      filtered = filtered.filter(b => !COMPLETED_STATUSES.has(b.status));
    } else if (activeFilter === 'sending') {
      filtered = filtered.filter(b => b.status === 'UNDER SENDING');
    } else if (activeFilter === 'upcoming') {
      filtered = filtered.filter(b => isUpcoming(b.utrop));
    } else if (activeFilter === 'completed') {
      filtered = filtered.filter(b => COMPLETED_STATUSES.has(b.status));
    }

    // Search
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
  function rowClass(booking) {
    if (booking.status === 'UNDER SENDING') return 'vt-row--sending';
    if (isUpcoming(booking.utrop)) return 'vt-row--upcoming';
    if (booking.status === 'ENDRET') return 'vt-row--changed';
    if (booking.status === 'BEH.MANUELT') return 'vt-row--manual';
    if (COMPLETED_STATUSES.has(booking.status)) return 'vt-row--completed';
    return 'vt-row--active';
  }

  function statusBadgeClass(status) {
    return STATUS_CSS[status] || 'default';
  }

  // ----------------------------------------------------------
  //  Build Overlay DOM
  // ----------------------------------------------------------
  function createOverlay() {
    // Toggle button (always present)
    const toggle = document.createElement('button');
    toggle.id = 'vt-toggle-btn';
    toggle.textContent = 'VT';
    toggle.title = 'Toggle Voss Taxi Wallboard';
    toggle.addEventListener('click', () => {
      overlayVisible = !overlayVisible;
      const wb = document.getElementById('vt-wallboard');
      if (wb) wb.classList.toggle('vt-hidden', !overlayVisible);
      // Resume audio context on interaction
      ensureAudioCtx();
    });
    document.body.appendChild(toggle);

    // Scroll indicator
    const scrollInd = document.createElement('div');
    scrollInd.id = 'vt-scroll-indicator';
    scrollInd.textContent = 'Auto-scroll paused';
    document.body.appendChild(scrollInd);

    // Main wallboard
    const wb = document.createElement('div');
    wb.id = 'vt-wallboard';
    wb.innerHTML = `
      <div id="vt-header">
        <div id="vt-header-left">
          <div id="vt-logo">Voss <span>Taxi</span> Wallboard</div>
        </div>
        <div id="vt-clock">00:00:00</div>
      </div>
      <div id="vt-stats"></div>
      <div id="vt-filter-bar">
        <input type="text" id="vt-search" placeholder="Search name, taxi, address, phone..." autocomplete="off" />
        <button class="vt-filter-btn active" data-filter="all">All</button>
        <button class="vt-filter-btn" data-filter="active">Active</button>
        <button class="vt-filter-btn" data-filter="sending">Under Sending</button>
        <button class="vt-filter-btn" data-filter="upcoming">Upcoming</button>
        <button class="vt-filter-btn" data-filter="completed">Completed</button>
        <button id="vt-mute-btn" title="Mute/unmute audio alerts">&#x1f50a; Sound</button>
      </div>
      <div id="vt-table-wrap">
        <table id="vt-table">
          <thead>
            <tr>
              <th>UTROP</th>
              <th>OPPMOTE</th>
              <th>TAXI</th>
              <th>STATUS</th>
              <th>FRA</th>
              <th>TIL</th>
              <th>NAVN</th>
              <th>TLF</th>
              <th>MELDING TIL BIL</th>
              <th>EGENSKAP</th>
              <th>ALTTURID</th>
            </tr>
          </thead>
          <tbody id="vt-tbody"></tbody>
        </table>
        <div id="vt-empty" style="display:none;">
          <div id="vt-empty-icon">&#x1f697;</div>
          <div>No bookings to display</div>
          <div style="font-size:13px;color:#374151;">Waiting for data from Taxiportalen...</div>
        </div>
      </div>
    `;
    document.body.appendChild(wb);

    // Event listeners
    document.getElementById('vt-search').addEventListener('input', (e) => {
      searchQuery = e.target.value;
      renderTable();
    });

    document.querySelectorAll('.vt-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeFilter = btn.dataset.filter;
        document.querySelectorAll('.vt-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderTable();
      });
    });

    document.getElementById('vt-mute-btn').addEventListener('click', () => {
      muted = !muted;
      const btn = document.getElementById('vt-mute-btn');
      btn.classList.toggle('muted', muted);
      btn.innerHTML = muted ? '&#x1f507; Muted' : '&#x1f50a; Sound';
      chrome.storage.local.set({ vtMuted: muted });
    });

    // Scroll tracking
    const wrap = document.getElementById('vt-table-wrap');
    wrap.addEventListener('scroll', () => {
      lastScrollTime = Date.now();
      document.getElementById('vt-scroll-indicator').classList.add('visible');
    });

    // Restore mute preference
    chrome.storage.local.get('vtMuted', (r) => {
      if (r.vtMuted) {
        muted = true;
        const btn = document.getElementById('vt-mute-btn');
        btn.classList.add('muted');
        btn.innerHTML = '&#x1f507; Muted';
      }
    });
  }

  // ----------------------------------------------------------
  //  Render
  // ----------------------------------------------------------
  function renderStats(displayed) {
    const total = displayed.length;
    const sending = displayed.filter(b => b.status === 'UNDER SENDING').length;
    const upcoming = displayed.filter(b => isUpcoming(b.utrop)).length;
    const active = displayed.filter(b => !COMPLETED_STATUSES.has(b.status) && b.status !== 'UNDER SENDING').length;
    const completed = displayed.filter(b => COMPLETED_STATUSES.has(b.status)).length;

    document.getElementById('vt-stats').innerHTML = `
      <div class="vt-stat vt-stat--total">
        <span class="vt-stat-dot"></span>
        <span class="vt-stat-value">${total}</span>
        <span>Total</span>
      </div>
      <div class="vt-stat vt-stat--sending">
        <span class="vt-stat-dot"></span>
        <span class="vt-stat-value">${sending}</span>
        <span>Under Sending</span>
      </div>
      <div class="vt-stat vt-stat--upcoming">
        <span class="vt-stat-dot"></span>
        <span class="vt-stat-value">${upcoming}</span>
        <span>Upcoming</span>
      </div>
      <div class="vt-stat vt-stat--active">
        <span class="vt-stat-dot"></span>
        <span class="vt-stat-value">${active}</span>
        <span>Active</span>
      </div>
      <div class="vt-stat vt-stat--completed">
        <span class="vt-stat-dot"></span>
        <span class="vt-stat-value">${completed}</span>
        <span>Completed</span>
      </div>
    `;
  }

  function renderTable() {
    const sorted = sortBookings([...bookings]);
    const displayed = filterBookings(sorted);

    renderStats(displayed);

    const tbody = document.getElementById('vt-tbody');
    const empty = document.getElementById('vt-empty');

    if (displayed.length === 0) {
      tbody.innerHTML = '';
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

    // If any member of an ALTTURID group is active, mark the whole group active
    const groupActive = {};
    for (const [aid, ids] of Object.entries(altGroups)) {
      if (ids.length <= 1) continue;
      groupActive[aid] = displayed.some(b =>
        b.altturid === aid && !COMPLETED_STATUSES.has(b.status)
      );
    }

    let html = '';
    for (let i = 0; i < displayed.length; i++) {
      const b = displayed[i];
      const isGrouped = b.altturid && altGroups[b.altturid] && altGroups[b.altturid].length > 1;
      const ids = isGrouped ? altGroups[b.altturid] : [];
      const isFirst = isGrouped && ids.indexOf(b.id) === 0;
      const isLast = isGrouped && ids.indexOf(b.id) === ids.length - 1;

      // Determine row class — if group is active, don't dim
      let rClass = rowClass(b);
      if (isGrouped && groupActive[b.altturid] && rClass === 'vt-row--completed') {
        rClass = 'vt-row--active';
      }

      let groupClasses = '';
      if (isGrouped) groupClasses += ' vt-group-member';
      if (isFirst) groupClasses += ' vt-group-start';
      if (isLast) groupClasses += ' vt-group-end';

      const statusSlug = statusBadgeClass(b.status);
      const groupBadge = isGrouped ? `<span class="vt-group-badge">G</span>` : '';

      html += `<tr class="${rClass}${groupClasses} vt-row-enter" data-id="${b.id}">
        <td><span class="vt-utrop-time">${formatTime24(b.utrop)}</span></td>
        <td><span class="vt-oppmote-time">${formatTime24(b.oppmote)}</span></td>
        <td><span class="vt-taxi-num">${esc(b.taxi)}</span></td>
        <td><span class="vt-status-badge vt-status--${statusSlug}">${esc(b.status)}</span></td>
        <td>${esc(b.fra)}</td>
        <td>${esc(b.til)}</td>
        <td>${esc(b.navn)}</td>
        <td>${esc(b.tlf)}</td>
        <td>${esc(b.meldingTilBil)}</td>
        <td>${esc(b.egenskap)}</td>
        <td>${esc(b.altturid)}${groupBadge}</td>
      </tr>`;
    }

    tbody.innerHTML = html;
  }

  function esc(s) {
    if (!s) return '';
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  // ----------------------------------------------------------
  //  Clock
  // ----------------------------------------------------------
  function updateClock() {
    const n = now();
    const el = document.getElementById('vt-clock');
    if (el) {
      el.textContent = pad(n.getHours()) + ':' + pad(n.getMinutes()) + ':' + pad(n.getSeconds());
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
        // Save chimed IDs so we don't re-chime on refresh
        break; // one chime per cycle to avoid noise flood
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
  //  Auto-scroll
  // ----------------------------------------------------------
  function checkAutoScroll() {
    if (Date.now() - lastScrollTime < SCROLL_IDLE_MS) return;

    const ind = document.getElementById('vt-scroll-indicator');
    if (ind) ind.classList.remove('visible');

    // Find first active row
    const row = document.querySelector(
      '#vt-tbody .vt-row--sending, #vt-tbody .vt-row--upcoming, #vt-tbody .vt-row--manual, #vt-tbody .vt-row--active'
    );
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    }

    checkUtropChimes();
    checkAutoScroll();
    updateClock();
  }

  // ----------------------------------------------------------
  //  MutationObserver
  // ----------------------------------------------------------
  function setupObserver() {
    const table = findBookingTable();
    if (!table) return false;

    const observer = new MutationObserver(() => {
      update();
    });

    observer.observe(table, {
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
    createOverlay();
    update();

    // Set up observer (with retry if table not found yet)
    let observerReady = setupObserver();
    if (!observerReady) {
      const retryObs = setInterval(() => {
        observerReady = setupObserver();
        if (observerReady) clearInterval(retryObs);
      }, 2000);
    }

    // Polling fallback
    setInterval(update, POLL_INTERVAL_MS);

    // Clock every second
    setInterval(updateClock, 1000);

    // Auto-scroll check
    setInterval(checkAutoScroll, 5000);
  }

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
