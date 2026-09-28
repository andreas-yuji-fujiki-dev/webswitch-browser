// Every action that can have a keyboard shortcut, with its default accelerators.
// Users override these from the Keybindings page; the overrides live in keybindings.json.
// Ctrl+1 .. Ctrl+8 (jump to tab N) are fixed and not part of this list.
export const SHORTCUT_ACTIONS = {
  newTab: { label: 'New tab', defaults: ['Ctrl+T'] },
  closeTab: { label: 'Close tab', defaults: ['Ctrl+W'] },
  reopenClosedTab: { label: 'Reopen closed tab', defaults: ['Ctrl+Shift+T'] },
  nextTab: { label: 'Next tab', defaults: ['Ctrl+Tab', 'Ctrl+PageDown'] },
  previousTab: { label: 'Previous tab', defaults: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'] },
  lastTab: { label: 'Last tab', defaults: ['Ctrl+9'] },
  openHistory: { label: 'History', defaults: ['Ctrl+H'] },
  focusAddressBar: { label: 'Focus address bar', defaults: ['Ctrl+L', 'Alt+D', 'F6'] },
  reload: { label: 'Reload', defaults: ['Ctrl+R', 'F5'] },
  hardReload: { label: 'Reload, ignoring cache', defaults: ['Ctrl+Shift+R', 'Ctrl+F5'] },
  goBack: { label: 'Back', defaults: ['Alt+ArrowLeft'] },
  goForward: { label: 'Forward', defaults: ['Alt+ArrowRight'] },
  toggleDevTools: { label: 'Open developer tools', defaults: ['F12', 'Ctrl+Shift+I'] },
  zoomIn: { label: 'Zoom in', defaults: ['Ctrl+=', 'Ctrl++'] },
  zoomOut: { label: 'Zoom out', defaults: ['Ctrl+-'] },
  zoomReset: { label: 'Reset zoom', defaults: ['Ctrl+0'] },
} as const;
