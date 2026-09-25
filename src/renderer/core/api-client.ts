import type { BrowserApi } from '~types/browser-api';

/** The only door from the UI to the main process: the API the preload script exposes. */
export const api: BrowserApi = window.browserApi;
