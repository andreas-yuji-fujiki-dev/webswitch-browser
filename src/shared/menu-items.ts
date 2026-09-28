// The menu, top to bottom. Items with the same `group` sit together; a border separates the groups.
// `icon` names an icon in the renderer's icon set.
export const MENU_ITEMS = [
  { id: 'updates', group: 'app', label: 'Check for updates', icon: 'download' },
  { id: 'user', group: 'browsing', label: 'Cookies and accounts', icon: 'user' },
  { id: 'settings', group: 'browsing', label: 'General settings', icon: 'settings' },
  { id: 'themes', group: 'browsing', label: 'Themes', icon: 'palette' },
  { id: 'extensions', group: 'browsing', label: 'Extensions', icon: 'puzzle' },
  { id: 'keybindings', group: 'browsing', label: 'Keybindings', icon: 'keyboard' },
  { id: 'history', group: 'browsing', label: 'History', icon: 'history' },
  { id: 'devSettings', group: 'browsing', label: 'Dev settings', icon: 'code' },
  // Not a row: the gear at the end of the row of browsers (see menu-panel.ts).
  { id: 'browsers', group: 'testing', label: 'Test in other browsers', icon: 'gear' },
] as const;
