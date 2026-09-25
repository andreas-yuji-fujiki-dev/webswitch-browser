import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import type { UserCssService } from './user-css.service';

export function registerUserCssIpc(router: IpcRouter, service: UserCssService): void {
  router.handle(IPC_CHANNELS.userCss.get, () => service.read());

  service.onChanged((css) => {
    router.emit(IPC_CHANNELS.userCss.changed, css);
  });
}
