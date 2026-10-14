import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 等のサブパス配信にも対応できるよう base は相対パス
export default defineConfig({
  plugins: [react()],
  base: './',
})
