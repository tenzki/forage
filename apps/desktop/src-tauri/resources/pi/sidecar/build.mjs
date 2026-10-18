import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const root = path.dirname(fileURLToPath(import.meta.url))
const supplied = { 'image-generation': 'image-generation', 'text-stats': 'reference', 'system-one': 'system-one' }

await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'info',
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: 'node22.19',
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      // Keep Node namespace re-exports intact across the shared entry chunks.
      // Rollup otherwise drops bindings from the generated builtin namespace.
      treeshake: false,
      input: {
        index: path.join(root, 'index.ts'),
        management: path.join(root, 'management.ts'),
        'mcp-management': path.join(root, 'mcp-management.ts'),
        'mcp-oauth': path.join(root, 'mcp-oauth.ts'),
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

// Read-only application sources, included in the existing sidecar resource bundle.
// Choosing them in setup never imports or registers their code.
for (const [id, directory] of Object.entries(supplied)) {
  const destination = path.join(root, 'dist/extensions', id)
  await build({
    root, configFile: false, publicDir: false, logLevel: 'warn', ssr: { noExternal: true },
    build: {
      ssr: true, target: 'node22.19', outDir: path.join(destination, 'dist'), emptyOutDir: true, minify: false,
      rollupOptions: {
        input: path.resolve(root, '../../../../../../extensions', directory, 'src/index.ts'),
        output: { entryFileNames: 'index.mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
      },
    },
  })
  const manifest = JSON.parse(await readFile(path.resolve(root, '../../../../../../extensions', directory, 'forage.extension.json'), 'utf8'))
  manifest.entry = './dist/index.mjs'
  await mkdir(destination, { recursive: true })
  await writeFile(path.join(destination, 'forage.extension.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(path.join(destination, 'package.json'), '{"type":"module"}\n')
}
