import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    /* 端口被占用时不要偷偷换到 5174：换个端口就是换个「来源」，
       localStorage 各存一份，用户会以为 token / 仓库没保存。宁可起不来也别换。 */
    strictPort: true,
    host: true,
  },
  preview: {
    port: 4173,
    /* 同上：dev(5173) 与 preview(4173) 本来就是两个来源，各存各的配置 */
    strictPort: true,
    host: true,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
