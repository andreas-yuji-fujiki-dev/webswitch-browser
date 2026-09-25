import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import type { ShortcutsService } from '../shortcuts/shortcuts.service';
import type { KeybindingsService } from './keybindings.service';

export function registerKeybindingsIpc(
  router: IpcRouter,
  service: KeybindingsService,
  shortcuts: ShortcutsService,
): void {
  router.handle(IPC_CHANNELS.keybindings.get, () => service.getState());
  router.handle(IPC_CHANNELS.keybindings.set, (actionId, accelerators) =>
    service.set(actionId, accelerators),
  );
  router.handle(IPC_CHANNELS.keybindings.reset, (actionId) => {
    service.reset(actionId);
  });
  router.handle(IPC_CHANNELS.keybindings.resetAll, () => {
    service.resetAll();
  });
  router.handle(IPC_CHANNELS.keybindings.setRecording, (recording) => {
    shortcuts.setRecording(recording);
  });

  service.onChanged((state) => {
    router.emit(IPC_CHANNELS.keybindings.changed, state);
  });
}
