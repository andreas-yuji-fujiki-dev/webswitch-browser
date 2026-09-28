import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import type { BrowserResult } from '~types/browsers';
import type { BrowsersService } from './browsers.service';

export function registerBrowsersIpc(
  router: IpcRouter,
  service: BrowsersService,
  /** Opens the current page in that browser inside a tab (or shows the manager when it is not installed). */
  open: (id: unknown) => BrowserResult,
): void {
  router.handle(IPC_CHANNELS.browsers.get, () => service.getState());
  router.handle(IPC_CHANNELS.browsers.check, () => service.check());
  router.handle(IPC_CHANNELS.browsers.install, (id, version) => service.install(id, version));
  router.handle(IPC_CHANNELS.browsers.uninstall, (id, version) => service.uninstall(id, version));
  router.handle(IPC_CHANNELS.browsers.use, (id, version) => service.use(id, version));
  router.handle(IPC_CHANNELS.browsers.open, (id) => open(id));
  router.handle(IPC_CHANNELS.browsers.setStreaming, (choice) => service.setStreaming(choice));

  service.onChanged((state) => {
    router.emit(IPC_CHANNELS.browsers.changed, state);
  });
}
