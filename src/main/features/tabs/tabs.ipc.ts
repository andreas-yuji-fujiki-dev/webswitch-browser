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

  service.onStateChanged((state) => {
    router.emit(IPC_CHANNELS.tabs.stateChanged, state);
  });
}
