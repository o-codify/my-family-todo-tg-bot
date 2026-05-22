import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(__dirname, '../..'), 'VITE_');
  return {
    envDir: resolve(__dirname, '../..'),
    plugins: [react()],
    server: {
      port: 5173,
      host: '0.0.0.0',
      strictPort: true,
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    define: {
      __DEV__: JSON.stringify(mode === 'development'),
    },
    build: {
      // Bump the warning threshold once and split the bundle: the React +
      // TanStack Query chunks dominate the gzipped size, and isolating
      // them lets browsers cache them across deploys.
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
            if (id.includes('@tanstack')) return 'vendor-query';
            if (id.includes('@telegram-apps') || id.includes('init-data-node'))
              return 'vendor-tg';
            return 'vendor';
          },
        },
      },
    },
    // ensure env is also visible in tests/build
    ...(env ? {} : {}),
  };
});
