// Builds everything into dist/: the UI (dist/renderer), the preload script and the GJS bundles.
import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'vite';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = 'true';

for (const configFile of [
  'vite.renderer.config.ts',
  'vite.preload.config.ts',
  'vite.main.config.ts',
]) {
  await build({ configFile, logLevel: 'warn' });
}
// The X11 helper of the embedded-tab experiment is a plain script, shipped next to the bundles.
mkdirSync('dist', { recursive: true });
copyFileSync('helpers/x11-embed.py', 'dist/x11-embed.py');
console.log('built into dist/');
