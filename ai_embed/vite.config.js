import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { searchPlugin } from './server/searchPlugin.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), searchPlugin()],
})
