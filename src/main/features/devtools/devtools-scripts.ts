// The JavaScript that connects Chrome DevTools' frontend to a page without any network socket.
//
// The frontend expects to open a WebSocket to a relay and the page-side script (Chii's target.js)
// expects to open one to the same relay. Both are given a stand-in for `WebSocket` that only
// answers for the address `webswitch-devtools`; every other WebSocket is left alone. The messages
// then travel: page -> (a DOM event) -> an isolated script world -> native -> the frontend view, and
// back the same way. Nothing listens on a port, so no other program or page can join the session.

/** Runs in the page's own world, before target.js. */
export const PAGE_SHIM = `(() => {
  if (window.__wsDevtoolsShim) return;
  window.__wsDevtoolsShim = true;
  const Real = window.WebSocket;
  const ours = (url) => /^wss?:\\/\\/webswitch-devtools\\//.test(String(url));
  class Fake extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.protocol = '';
      this.extensions = '';
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      const receive = (event) => {
        const message = new MessageEvent('message', { data: event.detail });
        if (this.onmessage) this.onmessage(message);
        this.dispatchEvent(message);
      };
      document.addEventListener('__ws_cdp_in', receive);
      this.stop = () => document.removeEventListener('__ws_cdp_in', receive);
      document.dispatchEvent(new CustomEvent('__ws_cdp_out', { detail: ${JSON.stringify('__ws_page_ready__')} }));
      setTimeout(() => {
        this.readyState = 1;
        const opened = new Event('open');
        if (this.onopen) this.onopen(opened);
        this.dispatchEvent(opened);
      }, 0);
    }
    send(data) {
      document.dispatchEvent(new CustomEvent('__ws_cdp_out', { detail: String(data) }));
    }
    close() {
      this.stop();
      this.readyState = 3;
      const closed = new Event('close');
      if (this.onclose) this.onclose(closed);
      this.dispatchEvent(closed);
    }
  }
  window.WebSocket = new Proxy(Real, {
    construct: (target, args) => (ours(args[0]) ? new Fake(args[0]) : Reflect.construct(target, args)),
  });
  window.ChiiServerUrl = 'https://webswitch-devtools/';
})();`;

/**
 * Runs in an isolated script world of the inspected page (the page's own scripts cannot see it or
 * its message handler): hands what the shim above emits to the native side.
 */
export const PAGE_BRIDGE = `(() => {
  if (window.__wsBridge) return;
  window.__wsBridge = true;
  document.addEventListener('__ws_cdp_out', (event) => {
    window.webkit.messageHandlers.wsdevtools.postMessage(String(event.detail));
  });
})();`;

/** What the page side sends once its stand-in socket exists and listens; not protocol JSON either. */
export const PAGE_READY = '__ws_page_ready__';

/** What the frontend sends when its stand-in socket "opened"; protocol messages are JSON, so it cannot clash. */
export const FRONTEND_OPEN = '__ws_open__';

/** Runs first in the DevTools panel's own view. */
export const FRONTEND_SHIM = `(() => {
  const Real = window.WebSocket;
  const post = (message) => window.webkit.messageHandlers.wsdevtools.postMessage(message);
  class Fake extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.protocol = '';
      this.extensions = '';
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      window.__wsDeliver = (message) => {
        const event = new MessageEvent('message', { data: message });
        if (this.onmessage) this.onmessage(event);
        this.dispatchEvent(event);
      };
      setTimeout(() => {
        this.readyState = 1;
        const opened = new Event('open');
        if (this.onopen) this.onopen(opened);
        this.dispatchEvent(opened);
        post(${JSON.stringify(FRONTEND_OPEN)});
      }, 0);
    }
    send(data) {
      post(String(data));
    }
    close() {
      this.readyState = 3;
      const closed = new Event('close');
      if (this.onclose) this.onclose(closed);
      this.dispatchEvent(closed);
    }
  }
  window.WebSocket = new Proxy(Real, {
    construct: (target, args) =>
      /^wss?:\\/\\/webswitch-devtools\\//.test(String(args[0]))
        ? new Fake(args[0])
        : Reflect.construct(target, args),
  });
})();`;

export function deliverToPage(message: string): string {
  return `document.dispatchEvent(new CustomEvent('__ws_cdp_in', { detail: ${JSON.stringify(message)} }));`;
}

export function deliverToFrontend(message: string): string {
  return `window.__wsDeliver && window.__wsDeliver(${JSON.stringify(message)});`;
}
