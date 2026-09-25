import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import type { NavigationService } from './navigation.service';

export function registerNavigationIpc(router: IpcRouter, service: NavigationService): void {
  router.handle(IPC_CHANNELS.navigation.navigate, (input) => {
    if (typeof input === 'string') service.navigate(input);
  });
  router.handle(IPC_CHANNELS.navigation.goBack, () => {
    service.goBack();
  });
  router.handle(IPC_CHANNELS.navigation.goForward, () => {
    service.goForward();
  });
  router.handle(IPC_CHANNELS.navigation.reload, () => {
    service.reload();
  });
  router.handle(IPC_CHANNELS.navigation.stop, () => {
    service.stop();
  });
}
