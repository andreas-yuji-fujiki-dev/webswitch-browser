import path from 'node:path';
import { defineConfig } from 'vite';
import { alias, OUT_DIR } from './vite.common';

// The browser UI, served to the UI web view through the webswitch:// scheme.
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  resolve: { alias },
  build: {
    outDir: path.resolve(__dirname, OUT_DIR, 'renderer'),
    emptyOutDir: true,
    target: 'esnext',
  },
});
