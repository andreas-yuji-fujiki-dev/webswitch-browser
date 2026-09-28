import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import type { DevToolsService } from './devtools.service';

export function registerDevToolsIpc(router: IpcRouter, service: DevToolsService): void {
  router.handle(IPC_CHANNELS.devtools.get, () => service.getState());
  router.handle(IPC_CHANNELS.devtools.use, (id) => service.use(id));
  router.handle(IPC_CHANNELS.devtools.check, () => service.check());
  router.handle(IPC_CHANNELS.devtools.download, (id, version) => service.download(id, version));
  router.handle(IPC_CHANNELS.devtools.uninstall, (id) => service.uninstall(id));

  service.onChanged((state) => {
    router.emit(IPC_CHANNELS.devtools.changed, state);
  });
}
