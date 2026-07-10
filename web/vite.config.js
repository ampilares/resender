import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// The SPA is served by the Fastify server in production from web/dist.
// In dev, proxy /api to the running server so credentials cookies work.
export default defineConfig({
    plugins: [react()],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
        },
    },
});
