import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.js so tests skip the editor/dev-server plugins.
export default defineConfig({
	plugins: [react()],
	resolve: { alias: { '@': path.resolve(__dirname, './src') } },
	test: { environment: 'jsdom', include: ['src/**/*.test.{js,jsx}'], restoreMocks: true },
});
