import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from './ipc-router';
import type { MainWindow } from './window';

/** The UI tells the window how it is laid out: chrome height, and where the tab strip is draggable. */
export function registerUiIpc(router: IpcRouter, main: MainWindow): void {
  router.handle(IPC_CHANNELS.tabs.setChromeHeight, (heightPx) => {
    if (Number.isFinite(heightPx) && heightPx >= 0) main.setChromeHeight(heightPx);
  });
  router.handle(IPC_CHANNELS.ui.setTitleBarLayout, (dragStartX, heightPx) => {
    if (Number.isFinite(dragStartX) && Number.isFinite(heightPx)) {
      main.setTitleBarLayout(dragStartX, heightPx);
    }
  });
}
