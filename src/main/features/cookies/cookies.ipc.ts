import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { IpcRouter } from '../../core/ipc-router';
import { companyInfo } from './cookie-catalog';
import type { CookiesService } from './cookies.service';

export function registerCookiesIpc(
  router: IpcRouter,
  service: CookiesService,
  /** Opens an address in a new tab. */
  openUrl: (url: string) => void,
): void {
  router.handle(IPC_CHANNELS.cookies.get, () => service.getState());
  router.handle(IPC_CHANNELS.cookies.remove, (ids) =>
    service.remove(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []),
  );
  router.handle(IPC_CHANNELS.cookies.setPolicy, (ids, policy) =>
    service.setPolicy(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [], policy),
  );
  router.handle(IPC_CHANNELS.cookies.setCompanyPolicy, (company, policy) =>
    typeof company === 'string' ? service.setCompanyPolicy(company, policy) : undefined,
  );
  // Only addresses from Webswitch's own list can be opened this way, never one the UI sends.
  router.handle(IPC_CHANNELS.cookies.openAccountPanel, (company) => {
    const panel = typeof company === 'string' ? companyInfo(company).accountPanel : null;
    if (panel) openUrl(panel.url);
  });

  service.onChanged(() => {
    router.emit(IPC_CHANNELS.cookies.changed, null);
  });
}
