import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import type { ExtensionResult } from '~types/extensions';
import type { ExtensionRuntime } from './extension-runtime';
import type { ExtensionsService } from './extensions.service';

export function registerExtensionsIpc(
  router: IpcRouter,
  service: ExtensionsService,
  runtime: ExtensionRuntime,
  /** Asks for a folder and returns its path (null when the user cancels). */
  chooseFolder: () => Promise<string | null>,
): void {
  router.handle(IPC_CHANNELS.extensions.get, () => service.getState());
  router.handle(IPC_CHANNELS.extensions.prepareStore, (input) => service.prepareFromStore(input));
  router.handle(IPC_CHANNELS.extensions.prepareFolder, (path) => service.prepareFromFolder(path));
  router.handle(IPC_CHANNELS.extensions.chooseFolder, async (): Promise<ExtensionResult | null> => {
    const path = await chooseFolder();
    return path === null ? null : service.prepareFromFolder(path);
  });
  router.handle(IPC_CHANNELS.extensions.confirm, () => service.confirm());
  router.handle(IPC_CHANNELS.extensions.cancel, () => service.cancel());
  router.handle(IPC_CHANNELS.extensions.setEnabled, (id, enabled) =>
    service.setEnabled(id, enabled),
  );
  router.handle(IPC_CHANNELS.extensions.remove, (id) => service.remove(id));
  router.handle(IPC_CHANNELS.extensions.openPopup, (id, x, y, width, height) =>
    runtime.openPopup(id, { x, y, width, height }),
  );
  router.handle(IPC_CHANNELS.extensions.clearProxy, () => {
    runtime.clearProxy();
  });
  router.handle(IPC_CHANNELS.extensions.openOptions, (id) => {
    runtime.openOptions(id);
  });

  service.onChanged((state) => {
    router.emit(IPC_CHANNELS.extensions.changed, state);
  });
}
