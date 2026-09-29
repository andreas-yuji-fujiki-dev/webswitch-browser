import { defineConfig } from 'vite';
import { alias, OUT_DIR } from './vite.common';

// The native side runs in GJS (GNOME's JavaScript runtime) as an ES module. GJS provides the
// `gi://` libraries (GTK, WebKit, ...) itself, so they must stay as imports in the bundle.
export default defineConfig({
  resolve: { alias },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: false,
    target: 'esnext',
    minify: false,
    lib: {
      entry: { main: 'src/main/main.ts', selftest: 'src/main/selftest.ts' },
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^gi:\/\//, /^resource:\/\//, /^cairo$/, /^system$/, /^gettext$/],
      output: { entryFileNames: '[name].js', chunkFileNames: '[name].js' },
    },
  },
});
