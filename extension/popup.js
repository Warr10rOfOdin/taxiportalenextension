// Popup script — minimal, just ensures the popup renders correctly
// Future: could display live stats from the content script via messaging
document.addEventListener('DOMContentLoaded', () => {
  // Check if the extension is running on any Taxiportalen tab
  if (chrome.tabs) {
    chrome.tabs.query({ url: '*://taxiportalen.no/*' }, (tabs) => {
      const statusBadge = document.querySelector('.badge');
      if (tabs && tabs.length > 0) {
        statusBadge.textContent = 'Active';
        statusBadge.className = 'badge badge-ok';
      } else {
        statusBadge.textContent = 'No Tab';
        statusBadge.className = 'badge badge-warn';
      }
    });
  }
});
