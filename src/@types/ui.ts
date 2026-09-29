import type { DevToolsProviderId, DevToolsState } from './devtools';
import type { Setting, SettingsState } from './settings';
import type { TabsState } from './tabs';

/** A built-in page drawn in the page area (Keybindings, History). */
export interface BuiltInPage {
  root: HTMLElement;
  /** The tab now shows this page. */
  show: () => void;
  /** The tab stopped showing this page. */
  hide: () => void;
}

/** A piece of UI that redraws itself from the tabs state pushed by the main process. */
export interface StateView {
  render: (state: TabsState) => void;
}

/** Interface choices Webswitch remembers between runs (`ui-state.json`). */
export interface UiStateFile {
  version: 1;
  /** Share of the window width the menu panel takes (0..1). */
  menuFraction?: number;
  /** Share of the page area's height the Chrome DevTools panel takes (0..1). */
  devtoolsFraction?: number;
}

/** A row of the Settings page. */
export interface SettingsRow {
  definition: Setting;
  root: HTMLElement;
  section: string;
  /** Redraws the row from the state; never rebuilds it, so the control keeps the keyboard focus. */
  update: (state: SettingsState) => void;
}

/** A row of the Dev settings page. */
export interface DevToolsRow {
  id: DevToolsProviderId;
  update: (state: DevToolsState) => void;
}
