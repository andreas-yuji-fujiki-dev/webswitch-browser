import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import type { BookmarksService } from './bookmarks.service';

export function registerBookmarksIpc(router: IpcRouter, service: BookmarksService): void {
  router.handle(IPC_CHANNELS.bookmarks.get, () => service.getState());
  router.handle(IPC_CHANNELS.bookmarks.add, (url, title, folderId) =>
    service.add(url, title, folderId),
  );
  router.handle(IPC_CHANNELS.bookmarks.update, (id, changes) => {
    service.update(id, changes);
  });
  router.handle(IPC_CHANNELS.bookmarks.remove, (id) => {
    service.remove(id);
  });
  router.handle(IPC_CHANNELS.bookmarks.addFolder, (title, parentId) =>
    service.addFolder(title, parentId),
  );
  router.handle(IPC_CHANNELS.bookmarks.renameFolder, (id, title) => {
    service.renameFolder(id, title);
  });
  router.handle(IPC_CHANNELS.bookmarks.removeFolder, (id) => {
    service.removeFolder(id);
  });
  router.handle(IPC_CHANNELS.bookmarks.reorderBar, (order) => {
    service.reorderBar(order);
  });

  service.onChanged((state) => {
    router.emit(IPC_CHANNELS.bookmarks.changed, state);
  });
}
