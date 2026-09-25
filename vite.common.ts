import path from 'node:path';
import type { AliasOptions } from 'vite';

// Keep in sync with "paths" in tsconfig.json. Never alias "@types": it collides with npm packages.
export const alias: AliasOptions = {
  '~types': path.resolve(__dirname, 'src/@types'),
  '~shared': path.resolve(__dirname, 'src/shared'),
};
