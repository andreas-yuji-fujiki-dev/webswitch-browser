import type { MENU_ITEMS } from '~shared/menu-items';

export type MenuItemId = (typeof MENU_ITEMS)[number]['id'];

export interface MenuState {
  open: boolean;
  /** How much of the window's width the panel takes (0..1) while it is open. */
  fraction: number;
}
