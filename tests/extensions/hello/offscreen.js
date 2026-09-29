chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message && message.type === 'to-offscreen') respond({ from: 'offscreen' });
});
