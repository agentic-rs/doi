import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite supplies the React transform for Vitest. Applet packaging uses esbuild.
export default defineConfig({ plugins: [react()] });
