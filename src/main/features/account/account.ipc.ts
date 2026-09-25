import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import type { AccountService } from './account.service';

export function registerAccountIpc(router: IpcRouter, service: AccountService): void {
  router.handle(IPC_CHANNELS.account.get, () => service.getState());

  service.onChanged((state) => {
    router.emit(IPC_CHANNELS.account.changed, state);
  });
}
