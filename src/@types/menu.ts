import type { MENU_ITEMS } from '~shared/menu-items';

export type MenuItemId = (typeof MENU_ITEMS)[number]['id'];

/** Bottom-right corner of the button the menu hangs from, in window coordinates (CSS px). */
export interface MenuAnchor {
  right: number;
  bottom: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export interface MenuState {
  open: boolean;
}
