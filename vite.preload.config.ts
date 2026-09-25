import { defineConfig } from 'vite';
import { alias } from './vite.common';

// The script injected into the browser UI before its own scripts run. It builds `window.browserApi`
// on top of the WebKit message handler. A single self-contained file, no imports at runtime.
export default defineConfig({
  resolve: { alias },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'esnext',
    minify: false,
    lib: {
      entry: 'src/preload/preload.ts',
      formats: ['iife'],
      name: 'WebswitchPreload',
      fileName: () => 'preload.js',
    },
  },
});
