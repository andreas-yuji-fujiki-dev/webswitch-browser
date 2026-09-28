import path from 'node:path';
import type { AliasOptions } from 'vite';

// Keep in sync with "paths" in tsconfig.json. Never alias "@types": it collides with npm packages.
export const alias: AliasOptions = {
  '~types': path.resolve(__dirname, 'src/@types'),
  '~shared': path.resolve(__dirname, 'src/shared'),
};

// Where a build goes. The self-test builds into its own folder, so it never rewrites the `dist/` a
// running browser is being served from (a build empties `dist/renderer` for a moment).
export const OUT_DIR = process.env.WEBSWITCH_OUT_DIR ?? 'dist';
