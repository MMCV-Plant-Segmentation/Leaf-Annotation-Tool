import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: '../static/dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: 'src/mount.tsx',
      output: {
        entryFileNames: 'app.bundle.js',
        assetFileNames: 'app.bundle.[ext]',
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    server: { deps: { inline: [/solid-js/, /@solidjs/] } },
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    conditions: ['development', 'browser'],
  },
});
