import GLib from 'gi://GLib?version=2.0';
import type WebKit from 'gi://WebKit?version=6.0';
import type { Unsubscribe } from '~types/common';
import type { MenuItemId, MenuState } from '~types/menu';
import { debug } from '../../core/debug';
import type { MainWindow } from '../../core/window';

const EMIT_INTERVAL_MS = 16;

/**
 * The menu is a panel that takes the right half of the window, below the tab strip and the
 * toolbar, while the page takes the left half. Its content is the same bundled UI, loaded in its
 * own web view with `?view=menu`. The layout itself (who gets which half) lives in `MainWindow`.
 */
export class MenuService {
  private readonly listeners = new Set<(state: MenuState) => void>();
  private readonly selectListeners = new Set<(itemId: MenuItemId) => void>();
  private emitTimer = 0;

  constructor(
    private readonly main: MainWindow,
    private readonly view: WebKit.WebView,
  ) {
    main.setSidePanel(view);
    // The UI's own page area makes room for the panel, so it must hear about every resize.
    main.onSidePanelFraction(() => {
      if (this.isOpen()) this.scheduleEmit();
    });
  }

  onStateChanged(listener: (state: MenuState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onSelect(listener: (itemId: MenuItemId) => void): Unsubscribe {
    this.selectListeners.add(listener);
    return () => {
      this.selectListeners.delete(listener);
    };
  }

  select(itemId: MenuItemId): void {
    this.close();
    for (const listener of this.selectListeners) listener(itemId);
  }

  toggle(): void {
    debug('menu', `toggle (now ${this.isOpen() ? 'open' : 'closed'})`);
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen()) return;
    this.main.setSidePanelOpen(true);
    // The panel takes the keyboard so Escape closes it.
    this.view.grab_focus();
    this.emitState();
  }

  close(): void {
    if (!this.isOpen()) return;
    this.main.setSidePanelOpen(false);
    this.emitState();
  }

  isOpen(): boolean {
    return this.main.isSidePanelOpen();
  }

  /** A drag changes the width many times a second; the UI is told at most once per frame. */
  private scheduleEmit(): void {
    if (this.emitTimer !== 0) return;
    this.emitTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EMIT_INTERVAL_MS, () => {
      this.emitTimer = 0;
      this.emitState();
      return GLib.SOURCE_REMOVE;
    });
  }

  private emitState(): void {
    const state: MenuState = { open: this.isOpen(), fraction: this.main.getSidePanelFraction() };
    for (const listener of this.listeners) listener(state);
  }
}
