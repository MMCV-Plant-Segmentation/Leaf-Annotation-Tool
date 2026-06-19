import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: '../static/dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/mount.tsx',
      output: {
        entryFileNames: 'analyze.bundle.js',
        assetFileNames: 'analyze.bundle.[ext]',
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
