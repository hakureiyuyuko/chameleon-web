// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vite'

// GitHub Pages 项目页会挂在 /<repo>/ 下，用相对 base 保证两种部署都正常
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: 'localhost',
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
})
