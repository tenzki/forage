import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = path.dirname(fileURLToPath(import.meta.url))

await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'info',
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: 'node18',
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: path.join(root, 'index.ts'),
        management: path.join(root, 'management.ts'),
        executor: path.join(root, 'executor.ts'),
        'executor-process': path.join(root, 'executor-process.ts'),
        'executor-worker': path.join(root, 'executor-worker.ts'),
        'validation-worker': path.join(root, 'validation-worker.ts'),
      },
      output: {
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
