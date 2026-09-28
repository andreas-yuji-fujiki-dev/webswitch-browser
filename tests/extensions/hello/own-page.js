document.documentElement.dataset.ownPage = 'yes';
chrome.runtime.sendMessage({ type: 'own-page-loaded' });
