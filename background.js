// ============================================================
//  Voss Taxi Wallboard — Background Service Worker
//  Updates the extension badge with live booking counts.
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // --- Badge update ---
  if (msg.type === 'vtBadgeUpdate') {
    const { sendingCount, upcomingCount, totalCount } = msg;
    if (sendingCount > 0) {
      chrome.action.setBadgeText({ text: String(sendingCount) });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    } else if (upcomingCount > 0) {
      chrome.action.setBadgeText({ text: String(upcomingCount) });
      chrome.action.setBadgeBackgroundColor({ color: '#fbbf24' });
    } else if (totalCount > 0) {
      chrome.action.setBadgeText({ text: String(totalCount) });
      chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
    return;
  }

  // --- API forward ---
  if (msg.type === 'vtApiForward') {
    chrome.storage.local.get(['vtApiUrl', 'vtApiKey'], (cfg) => {
      if (!cfg.vtApiUrl) {
        sendResponse({ ok: false, error: 'No API URL configured' });
        return;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.vtApiKey) headers['X-API-Key'] = cfg.vtApiKey;

      fetch(cfg.vtApiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(msg.payload),
      })
      .then(res => {
        sendResponse({ ok: res.ok, status: res.status });
      })
      .catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
    });
    return true; // keep sendResponse channel open for async
  }
});

// Clear badge when extension starts
chrome.action.setBadgeText({ text: '' });
