import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import type { TabsService } from './tabs.service';

export function registerTabsIpc(router: IpcRouter, service: TabsService): void {
  router.handle(IPC_CHANNELS.tabs.getState, () => service.getState());
  router.handle(IPC_CHANNELS.tabs.create, () => {
    service.createTab();
  });
  router.handle(IPC_CHANNELS.tabs.close, (tabId) => {
    service.closeTab(tabId);
  });
  router.handle(IPC_CHANNELS.tabs.activate, (tabId) => {
    service.activateTab(tabId);
  });
  // Only a plain HTTP status number reaches here, never a URL the UI sends. MDN, not http.cat's own
  // "see more" page (http.cat/status/<code>/): that one sits behind Cloudflare bot protection that
  // refuses WebKitGTK's own requests too (a real 403, confirmed by hand), where the plain image
  // address the fallback's own picture comes from (http.cat/<code>, no /status/) is not protected.
  router.handle(IPC_CHANNELS.tabs.openHttpStatus, (status) => {
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      service.createTab(
        `https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${String(status)}`,
      );
    }
  });

  service.onStateChanged((state) => {
    router.emit(IPC_CHANNELS.tabs.stateChanged, state);
  });
}
