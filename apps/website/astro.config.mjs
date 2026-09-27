import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  output: 'static',
  site: process.env.WEBSITE_URL || undefined,
  vite: { plugins: [tailwindcss()] },
})
