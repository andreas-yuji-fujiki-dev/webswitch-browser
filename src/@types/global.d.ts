import type { BrowserApi } from './browser-api';

declare global {
  interface Window {
    /** Built by the preload script (src/preload) before the UI's own scripts run. */
    browserApi: BrowserApi;
    /** Called by the native side to deliver an event to the UI (see IpcRouter.emit). */
    __wsEmit: (channel: string, payload: unknown) => void;
    /** WebKitGTK's script message bridge. `ipc` is registered only on the browser's own views. */
    webkit: {
      messageHandlers: {
        ipc: { postMessage: (message: unknown) => Promise<string> };
      };
    };
  }
}
