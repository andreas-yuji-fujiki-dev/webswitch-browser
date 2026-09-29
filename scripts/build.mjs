// Builds everything into dist/: the UI (dist/renderer), the preload script and the GJS bundles.
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'vite';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = 'true';
// The self-test builds into its own folder (see vite.common.ts).
const out = process.env.WEBSWITCH_OUT_DIR ?? 'dist';

for (const configFile of [
  'vite.renderer.config.ts',
  'vite.preload.config.ts',
  'vite.main.config.ts',
]) {
  await build({ configFile, logLevel: 'warn' });
}
// The X11 helper of the embedded-tab experiment is a plain script, shipped next to the bundles.
mkdirSync(out, { recursive: true });
copyFileSync('helpers/x11-embed.py', `${out}/x11-embed.py`);
// Chrome DevTools (the Chii build of Chrome's frontend) ships inside the app: the default F12.
mkdirSync(`${out}/devtools/chrome`, { recursive: true });
cpSync('node_modules/chii/public/front_end', `${out}/devtools/chrome/front_end`, {
  recursive: true,
});
copyFileSync('node_modules/chii/public/target.js', `${out}/devtools/chrome/target.js`);
copyFileSync('node_modules/chii/LICENSE', `${out}/devtools/chrome/LICENSE`);
const chiiVersion = JSON.parse(readFileSync('node_modules/chii/package.json', 'utf8')).version;
writeFileSync(`${out}/devtools/chrome/version.json`, JSON.stringify({ version: chiiVersion }));
console.log(`built into ${out}/`);
