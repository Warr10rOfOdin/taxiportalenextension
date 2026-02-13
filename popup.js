// ============================================================
//  Voss Taxi Wallboard — Popup Script
//  Shows extension status and live booking stats.
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const statusBadge = document.getElementById('status-badge');
  const statsSection = document.getElementById('stats-section');

  // Check for active Taxiportalen tabs
  if (chrome.tabs) {
    chrome.tabs.query({ url: ['*://taxiportalen.no/*', '*://*.taxiportalen.no/*'] }, (tabs) => {
      if (tabs && tabs.length > 0) {
        statusBadge.textContent = 'Active';
        statusBadge.className = 'badge badge-ok';

        // Request live stats from the content script
        chrome.tabs.sendMessage(tabs[0].id, { type: 'vtGetStats' }, (response) => {
          if (chrome.runtime.lastError || !response) return;
          statsSection.style.display = 'block';
          document.getElementById('stat-total').textContent = response.total || 0;
          document.getElementById('stat-sending').textContent = response.sending || 0;
          document.getElementById('stat-upcoming').textContent = response.upcoming || 0;
          document.getElementById('stat-completed').textContent = response.completed || 0;
        });
      } else {
        statusBadge.textContent = 'No Tab';
        statusBadge.className = 'badge badge-warn';
      }
    });
  }
});
