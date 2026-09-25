import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { agentPlugin } from './server/agentPlugin.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), agentPlugin()],
})
