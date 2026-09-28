import GLib from 'gi://GLib?version=2.0';
import { SETTINGS } from '~shared/settings-catalog';
import { SETTINGS_FILENAME } from '../../core/config';
import { debug } from '../../core/debug';
import { writeText } from '../../core/files';
import { configDir } from '../../core/paths';
import type { Unsubscribe } from '~types/common';
import type {
  SettingDefinition,
  SettingId,
  SettingResult,
  SettingsFile,
  SettingsReader,
  SettingsState,
  SettingsValues,
  SettingValue,
} from '~types/settings';

const DEFINITIONS = new Map<string, SettingDefinition>(SETTINGS.map((d) => [d.id, d]));
const MAX_TEXT_LENGTH = 1024;

/**
 * Environment variables the browser had before the Settings page existed. They still win over what
 * the user chose (they are how tests and benchmarks pin a behavior); the page says so.
 */
const ENV_OVERRIDES: Partial<Record<SettingId, () => SettingValue | undefined>> = {
  gpuAcceleration: () => (GLib.getenv('WEBSWITCH_HW_ACCEL') === '1' ? true : undefined),
  integratedGpuOnly: () => (GLib.getenv('WEBSWITCH_GPU') === 'integrated' ? true : undefined),
  embedStreaming: () => (GLib.getenv('WEBSWITCH_EMBED_DRM') === '0' ? false : undefined),
};

/** The value if it is valid for the setting, else undefined. */
function coerce(definition: SettingDefinition, raw: unknown): SettingValue | undefined {
  switch (definition.kind) {
    case 'toggle':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'choice':
      return typeof raw === 'string' && definition.options.some((option) => option.value === raw)
        ? raw
        : undefined;
    case 'text':
      return typeof raw === 'string' && raw.length <= MAX_TEXT_LENGTH ? raw.trim() : undefined;
  }
}

/** Reads the file at once: some settings (GPU, X11) are needed before the window exists. */
function readStored(path: string): Map<string, SettingValue> {
  const stored = new Map<string, SettingValue>();
  try {
    const [, bytes] = GLib.file_get_contents(path);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SettingsFile>;
    for (const [id, raw] of Object.entries(parsed.values ?? {})) {
      const definition = DEFINITIONS.get(id);
      const value = definition ? coerce(definition, raw) : undefined;
      if (value !== undefined && value !== definition?.default) stored.set(id, value);
    }
  } catch {
    // No file yet, or one that is not valid JSON: the defaults apply and the next change rewrites it.
  }
  return stored;
}

/**
 * The single source of truth for the general settings. The user's choices live in
 * `~/.config/webswitch/settings.json` (only what differs from the defaults); the Settings page
 * edits them through this class, which validates every value. Settings that only work after a
 * restart are reported in `restartPending` until the browser has been restarted.
 */
export class SettingsService implements SettingsReader {
  readonly filePath = GLib.build_filenamev([configDir(), SETTINGS_FILENAME]);
  private readonly stored: Map<string, SettingValue>;
  /** What every setting was when this run started, to tell what a restart would change. */
  private readonly atStartup: Map<string, SettingValue>;
  private readonly listeners = new Set<(state: SettingsState) => void>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.stored = readStored(this.filePath);
    this.atStartup = new Map(SETTINGS.map((d) => [d.id, this.effective(d.id)]));
  }

  get<K extends SettingId>(id: K): SettingsValues[K] {
    return this.effective(id) as SettingsValues[K];
  }

  getState(): SettingsState {
    const values = Object.fromEntries(
      SETTINGS.map((d) => [d.id, this.stored.get(d.id) ?? d.default]),
    ) as SettingsValues;
    return {
      values,
      restartPending: SETTINGS.filter(
        (d) => d.effect === 'restart' && this.effective(d.id) !== this.atStartup.get(d.id),
      ).map((d) => d.id),
      overriddenByEnv: SETTINGS.filter((d) => this.envOverride(d.id) !== undefined).map(
        (d) => d.id,
      ),
    };
  }

  onChanged(listener: (state: SettingsState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(id: SettingId, raw: unknown): SettingResult {
    const definition = DEFINITIONS.get(id);
    if (!definition) return { ok: false, error: 'Unknown setting.' };
    const value = coerce(definition, raw);
    if (value === undefined) return { ok: false, error: 'That value is not valid here.' };
    if (definition.id === 'downloadFolder' && typeof value === 'string' && value !== '') {
      if (!value.startsWith('/') || !GLib.file_test(value, GLib.FileTest.IS_DIR)) {
        return {
          ok: false,
          error: 'That folder does not exist. Use a full path like /home/you/Downloads.',
        };
      }
    }
    if (value === definition.default) this.stored.delete(id);
    else this.stored.set(id, value);
    this.commit();
    return { ok: true };
  }

  reset(id: SettingId): void {
    if (this.stored.delete(id)) this.commit();
  }

  resetAll(): void {
    if (this.stored.size === 0) return;
    this.stored.clear();
    this.commit();
  }

  private envOverride(id: SettingId): SettingValue | undefined {
    return ENV_OVERRIDES[id]?.();
  }

  private effective(id: string): SettingValue {
    const definition = DEFINITIONS.get(id);
    if (!definition) throw new Error(`Unknown setting: ${id}`);
    return this.envOverride(id as SettingId) ?? this.stored.get(id) ?? definition.default;
  }

  private commit(): void {
    const file: SettingsFile = { version: 1, values: Object.fromEntries(this.stored) };
    const text = `${JSON.stringify(file, null, 2)}\n`;
    this.writeQueue = this.writeQueue
      .then(() => writeText(this.filePath, text))
      .catch((error: unknown) => {
        debug('settings', `could not save ${this.filePath}: ${String(error)}`);
      });
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
