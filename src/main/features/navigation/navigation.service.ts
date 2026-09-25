import { DEFAULT_SEARCH_ENGINE } from '../../core/config';
import type { TabsService } from '../tabs/tabs.service';
import { resolveInput } from './url-resolver';

/** Navigation commands for the active tab. */
export class NavigationService {
  constructor(private readonly tabs: TabsService) {}

  navigate(input: string): void {
    const tabId = this.tabs.getActiveTabId();
    const url = resolveInput(input, DEFAULT_SEARCH_ENGINE);
    if (tabId === null || url === null) return;
    this.tabs.loadUrl(tabId, url);
    this.tabs.focusContent();
  }

  goBack(): void {
    const view = this.tabs.getActiveView();
    if (view?.can_go_back()) view.go_back();
  }

  goForward(): void {
    const view = this.tabs.getActiveView();
    if (view?.can_go_forward()) view.go_forward();
  }

  reload(): void {
    const view = this.tabs.getActiveView();
    if (view && (view.get_uri() ?? '') !== '') view.reload();
  }

  /** Reload that skips the HTTP cache. */
  hardReload(): void {
    const view = this.tabs.getActiveView();
    if (view && (view.get_uri() ?? '') !== '') view.reload_bypass_cache();
  }

  stop(): void {
    this.tabs.getActiveView()?.stop_loading();
  }
}
