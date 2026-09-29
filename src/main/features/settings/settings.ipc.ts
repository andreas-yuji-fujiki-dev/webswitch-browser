import { IPC_CHANNELS } from '~shared/ipc-channels';
import { SETTINGS } from '~shared/settings-catalog';
import type { IpcRouter } from '../../core/ipc-router';
import type { SettingId } from '~types/settings';
import type { SettingsService } from './settings.service';

function isSettingId(value: unknown): value is SettingId {
  return typeof value === 'string' && SETTINGS.some((setting) => setting.id === value);
}

export function registerSettingsIpc(
  router: IpcRouter,
  service: SettingsService,
  /** Closes the browser and starts it again. */
  restart: () => void,
): void {
  router.handle(IPC_CHANNELS.settings.get, () => service.getState());
  router.handle(IPC_CHANNELS.settings.set, (id, value) =>
    isSettingId(id) ? service.set(id, value) : { ok: false, error: 'Unknown setting.' },
  );
  router.handle(IPC_CHANNELS.settings.reset, (id) => {
    if (isSettingId(id)) service.reset(id);
  });
  router.handle(IPC_CHANNELS.settings.resetAll, () => {
    service.resetAll();
  });
  router.handle(IPC_CHANNELS.settings.restart, restart);

  service.onChanged((state) => {
    router.emit(IPC_CHANNELS.settings.changed, state);
  });
}
