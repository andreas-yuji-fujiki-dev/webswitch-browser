import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import type { OpenVsx } from './openvsx';
import type { ThemesService } from './themes.service';

export function registerThemesIpc(
  router: IpcRouter,
  service: ThemesService,
  openVsx: OpenVsx,
  /** Asks the user for a theme file; the path, or null when they cancelled. */
  chooseFile: () => Promise<string | null>,
): void {
  router.handle(IPC_CHANNELS.themes.get, () => service.getState());
  router.handle(IPC_CHANNELS.themes.select, (id) => service.select(id));
  router.handle(IPC_CHANNELS.themes.add, (json) => service.add(json));
  router.handle(IPC_CHANNELS.themes.searchVsx, (query, offset, sort) =>
    openVsx.search(query, offset, sort),
  );
  router.handle(IPC_CHANNELS.themes.installVsx, (namespace, name) =>
    openVsx.install(namespace, name),
  );
  router.handle(IPC_CHANNELS.themes.installPopular, (count) => openVsx.installPopular(count));
  router.handle(IPC_CHANNELS.themes.remove, (id) => service.remove(id));
  router.handle(IPC_CHANNELS.themes.importFile, async () => {
    const path = await chooseFile();
    return path === null ? null : service.addFromFile(path);
  });

  service.onChanged((state) => {
    router.emit(IPC_CHANNELS.themes.changed, state);
  });
}
