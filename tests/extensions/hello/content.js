const root = document.documentElement;
root.dataset.hello = 'yes';
chrome.runtime.sendMessage({ type: 'ping', value: 42 }).then((reply) => {
  root.dataset.reply = JSON.stringify(reply);
});
chrome.runtime.sendMessage({ type: 'fetch', url: location.origin + '/two.html' }).then((reply) => {
  root.dataset.fetched = JSON.stringify(reply);
});
chrome.storage.local.get('background').then((items) => {
  root.dataset.stored = items.background || 'none';
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.popup) root.dataset.popup = changes.popup.newValue;
  if (changes.popupTitle) root.dataset.popupTitle = changes.popupTitle.newValue;
  if (changes.options) root.dataset.options = changes.options.newValue;
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message === 'title') respond(document.title);
});

// A port: the background page answers what is sent on it.
const port = chrome.runtime.connect({ name: 'fixture-port' });
port.onMessage.addListener((message) => {
  root.dataset.port = JSON.stringify(message);
});
port.postMessage({ hi: 1 });
chrome.runtime.sendMessage({ type: 'cookie', url: location.origin + '/' }).then((reply) => {
  root.dataset.cookie = JSON.stringify(reply);
});
// What the background page has seen so far, asked for once the page is settled.
setTimeout(() => {
  chrome.runtime.sendMessage({ type: 'status' }).then((reply) => {
    root.dataset.status = JSON.stringify(reply);
  });
}, 700);
