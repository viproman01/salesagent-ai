import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const proxyTarget = env.VITE_API_PROXY_TARGET?.trim() || 'http://127.0.0.1:3000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'react-router-dom'],
            'charts':       ['recharts'],
            'wavesurfer':   ['wavesurfer.js'],
            'radix':        [
              '@radix-ui/react-tooltip',
              '@radix-ui/react-dialog',
              '@radix-ui/react-tabs',
              '@radix-ui/react-dropdown-menu',
            ],
          },
        },
      },
    },
  };
});
