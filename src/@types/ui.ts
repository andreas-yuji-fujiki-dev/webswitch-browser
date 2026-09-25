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
