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
  resolve: {
    conditions: ['development', 'browser'],
  },
});
