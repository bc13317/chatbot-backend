import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/chat': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  }
});
