// ============================================================
//  Voss Taxi Wallboard — Background Service Worker
//  Updates the extension badge with live booking counts.
// ============================================================

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'vtBadgeUpdate') return;

  const { sendingCount, upcomingCount, totalCount } = msg;

  // Priority: show UNDER SENDING count (red), then upcoming (yellow), then total (blue)
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
});

// Clear badge when extension starts
chrome.action.setBadgeText({ text: '' });
