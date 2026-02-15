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

  // --- API Forward settings ---
  const apiUrlInput = document.getElementById('api-url');
  const apiKeyInput = document.getElementById('api-key');
  const apiStatus = document.getElementById('api-status');

  // Load saved settings
  chrome.storage.local.get(['vtApiUrl', 'vtApiKey'], (r) => {
    if (r.vtApiUrl) apiUrlInput.value = r.vtApiUrl;
    if (r.vtApiKey) apiKeyInput.value = r.vtApiKey;
  });

  // Save
  document.getElementById('api-save').addEventListener('click', () => {
    const url = apiUrlInput.value.trim();
    const key = apiKeyInput.value.trim();
    chrome.storage.local.set({ vtApiUrl: url, vtApiKey: key }, () => {
      apiStatus.textContent = 'Saved';
      apiStatus.style.color = '#86efac';
      setTimeout(() => { apiStatus.textContent = ''; }, 2000);
    });
  });

  // Test
  document.getElementById('api-test').addEventListener('click', () => {
    const url = apiUrlInput.value.trim();
    const key = apiKeyInput.value.trim();
    if (!url) {
      apiStatus.textContent = 'Enter a URL first';
      apiStatus.style.color = '#fca5a5';
      return;
    }
    apiStatus.textContent = 'Testing...';
    apiStatus.style.color = '#fbbf24';

    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'X-API-Key': key } : {}),
      },
      body: JSON.stringify({ test: true, source: 'voss-taxi-wallboard', timestamp: new Date().toISOString() }),
    })
    .then((res) => {
      if (res.ok) {
        apiStatus.textContent = 'OK (' + res.status + ')';
        apiStatus.style.color = '#86efac';
      } else {
        apiStatus.textContent = 'Error ' + res.status;
        apiStatus.style.color = '#fca5a5';
      }
    })
    .catch((err) => {
      apiStatus.textContent = err.message || 'Failed';
      apiStatus.style.color = '#fca5a5';
    });
  });
});
