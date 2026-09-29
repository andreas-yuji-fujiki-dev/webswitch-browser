import { IPC_CHANNELS } from '~shared/ipc-channels';
import { MENU_ITEMS } from '~shared/menu-items';
import type { IpcRouter } from '../../core/ipc-router';
import type { MenuService } from './menu.service';

export function registerMenuIpc(router: IpcRouter, service: MenuService): void {
  router.handle(IPC_CHANNELS.menu.toggle, () => {
    service.toggle();
  });
  router.handle(IPC_CHANNELS.menu.close, () => {
    service.close();
  });
  router.handle(IPC_CHANNELS.menu.select, (itemId) => {
    if (MENU_ITEMS.some((item) => item.id === itemId)) service.select(itemId);
  });

  service.onStateChanged((state) => {
    router.emit(IPC_CHANNELS.menu.stateChanged, state);
  });
}
