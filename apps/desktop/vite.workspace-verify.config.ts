import { mergeConfig } from 'vite'
import base from './vite.config'
export default mergeConfig(base, {
  build: { outDir: 'verification-dist', rollupOptions: { input: 'verify/index.html' } },
})
