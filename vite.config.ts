import { defineConfig } from 'vite';

const githubRepository = process.env.GITHUB_REPOSITORY?.split('/')[1];

export default defineConfig({
  // GitHub project Pages needs an explicit repository prefix so public assets
  // referenced by CSS resolve below /<repository>/ instead of the site root.
  base: githubRepository ? `/${githubRepository}/` : './',
  server: {
    host: '127.0.0.1',
    port: 5190,
    strictPort: true,
    hmr: process.env.PLAYWRIGHT_DISABLE_HMR === '1' ? false : undefined,
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
