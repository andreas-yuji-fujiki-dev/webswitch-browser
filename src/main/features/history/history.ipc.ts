import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import type { HistoryService } from './history.service';

export function registerHistoryIpc(router: IpcRouter, service: HistoryService): void {
  router.handle(IPC_CHANNELS.history.query, (search, limit) =>
    service.query(typeof search === 'string' ? search : '', limit),
  );
  router.handle(IPC_CHANNELS.history.remove, (visitedAt) => {
    service.remove(visitedAt);
  });
  router.handle(IPC_CHANNELS.history.clear, () => {
    service.clear();
  });

  service.onChanged(() => {
    router.emit(IPC_CHANNELS.history.changed, null);
  });
}
