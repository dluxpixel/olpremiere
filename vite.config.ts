import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: {
    // The transcribe worker dynamic-imports transformers.js (code-splitting),
    // which the default iife worker format cannot express. Every supported
    // browser (WebCodecs-class) runs module workers.
    format: 'es',
  },
})
