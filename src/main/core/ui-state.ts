import GLib from 'gi://GLib?version=2.0';
import type { UiStateFile } from '~types/ui';
import { readText, writeText } from './files';
import { dataDir } from './paths';

function statePath(): string {
  return GLib.build_filenamev([dataDir(), 'ui-state.json']);
}

/** What was remembered last time; an unreadable or missing file is an empty state. */
export async function loadUiState(): Promise<UiStateFile> {
  const text = await readText(statePath());
  if (text !== null) {
    try {
      const parsed = JSON.parse(text) as Partial<UiStateFile>;
      if (parsed.version === 1)
        return {
          version: 1,
          menuFraction: parsed.menuFraction,
          devtoolsFraction: parsed.devtoolsFraction,
        };
    } catch {
      // A damaged file just means starting from the defaults.
    }
  }
  return { version: 1 };
}

let current: UiStateFile | null = null;

/** Merges `change` into the remembered state and writes it. */
export async function saveUiState(change: Partial<UiStateFile>): Promise<void> {
  current ??= await loadUiState();
  current = { ...current, ...change, version: 1 };
  await writeText(statePath(), JSON.stringify(current));
}
