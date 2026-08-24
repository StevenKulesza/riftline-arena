import { defineConfig } from 'vite';

export default defineConfig({
  // Relative production URLs work at both a GitHub project Pages path and a
  // custom/root domain without maintaining separate build configurations.
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5190,
    strictPort: true,
    watch: {
      ignored: ['**/artifacts/**', '**/test-results/**', '**/dist/**'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
