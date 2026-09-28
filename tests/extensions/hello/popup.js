chrome.storage.local.set({ popup: 'opened' });
chrome.tabs.query({ active: true }, (tabs) => {
  chrome.tabs.sendMessage(tabs[0].id, 'title', (title) => {
    chrome.storage.local.set({ popupTitle: title });
  });
});
