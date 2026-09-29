// Second extension for the self-test's cross-extension messaging check. Its manifest's
// `externally_connectable.ids` names the `hello` fixture's real id (patched in by the self-test,
// which only knows it once `hello` is installed — see extensionsScenario in selftest.ts), so a
// message or a port from `hello` should reach it, and one from anywhere else should not.
const state = { messages: [], ports: [], portMessages: [], helloReply: null };
self.state = state;

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  state.messages.push({ message, senderId: sender.id });
  sendResponse({ echoedFrom: sender.id, ok: true });
  return true;
});

chrome.runtime.onConnectExternal.addListener((port) => {
  state.ports.push(port.sender ? port.sender.id : null);
  port.onMessage.addListener((message) => {
    state.portMessages.push(message);
    port.postMessage({ echo: message });
  });
});

// The reverse direction: `hello` never declares `externally_connectable`, so this must be refused
// (resolve with `undefined`, exactly like Chrome answers a message nobody was listening for).
self.tryMessageHello = (helloId) =>
  chrome.runtime.sendMessage(helloId, { type: 'external-ping' }).then((reply) => {
    state.helloReply = reply === undefined ? 'undefined' : JSON.stringify(reply);
  });
