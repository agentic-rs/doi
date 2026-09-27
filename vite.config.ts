import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const mobile_host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: mobile_host || '127.0.0.1',
    port: 1427,
    strictPort: true,
    hmr: mobile_host ? { protocol: 'ws', host: mobile_host, port: 1428 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: { target: ['es2022', 'safari18'] },
});
