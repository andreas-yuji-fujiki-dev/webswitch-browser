import type { SETTINGS } from '~shared/settings-catalog';

/** When a change takes effect: at once, on the next load of a page, or only after a restart. */
export type SettingEffect = 'now' | 'reload' | 'restart';

export type SettingSectionId = 'performance' | 'privacy' | 'pages' | 'search' | 'downloads';

interface SettingBase {
  id: string;
  section: SettingSectionId;
  label: string;
  description: string;
  effect: SettingEffect;
}

export interface ToggleSetting extends SettingBase {
  kind: 'toggle';
  default: boolean;
}

export interface ChoiceSetting extends SettingBase {
  kind: 'choice';
  default: string;
  options: readonly { value: string; label: string }[];
}

export interface TextSetting extends SettingBase {
  kind: 'text';
  default: string;
  placeholder: string;
}

export type SettingDefinition = ToggleSetting | ChoiceSetting | TextSetting;

type Definition = (typeof SETTINGS)[number];

/** One entry of the catalog, with its literal id and default. */
export type Setting = Definition;

export type SettingId = Definition['id'];

type ValueOf<D> = D extends { kind: 'toggle' }
  ? boolean
  : D extends { kind: 'choice'; options: readonly { value: infer V }[] }
    ? V
    : D extends { kind: 'text' }
      ? string
      : never;

/** Every setting with the type of its value: a toggle is a boolean, a choice one of its options. */
export type SettingsValues = { [D in Definition as D['id']]: ValueOf<D> };

export type SettingValue = boolean | string;

/** What the parts of the browser that only need to read a setting depend on. */
export interface SettingsReader {
  /** The value in effect (an environment variable overrides what the user chose). */
  get: <K extends SettingId>(id: K) => SettingsValues[K];
}

export interface SettingsState {
  /** What the user chose (a setting never changed shows its default). */
  values: SettingsValues;
  /** Settings that only take effect after a restart and were changed since this run started. */
  restartPending: SettingId[];
  /** Settings an environment variable (WEBSWITCH_*) currently overrides, whatever `values` says. */
  overriddenByEnv: SettingId[];
}

export type SettingResult = { ok: true } | { ok: false; error: string };

/** `settings.json`: only what differs from the defaults. */
export interface SettingsFile {
  version: 1;
  values: Partial<Record<string, SettingValue>>;
}
