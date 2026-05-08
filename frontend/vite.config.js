import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function withProxyLogging(path, target) {
  return {
    target,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (proxyReq, req) => {
        console.log(`[proxy] ${req.method} ${req.url} -> ${target}${proxyReq.path}`);
      });
      proxy.on('proxyRes', (proxyRes, req) => {
        console.log(`[proxy] ${proxyRes.statusCode} ${req.method} ${req.url}`);
      });
      proxy.on('error', (err, req, res) => {
        console.error(`[proxy] error for ${req.method} ${req.url}: ${err.message}`);
        if (res && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            message: 'Backend connection reset. Please retry once backend is stable.',
            code: err.code || 'PROXY_ERROR',
          }));
        }
      });
    },
  };
}

const proxyTarget = process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': withProxyLogging('/api', proxyTarget),
      '/health': withProxyLogging('/health', proxyTarget),
    },
  },
});
