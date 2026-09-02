import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), 'utf8'))
}

test('the repository root is only the workspace orchestrator', () => {
  const rootManifest = readJson('package.json')

  assert.equal(rootManifest.name, '@forage/workspace')
  assert.deepEqual(rootManifest.workspaces, ['apps/*', 'packages/*'])
  assert.match(rootManifest.scripts.dev, /dev:infra/)
  assert.match(rootManifest.scripts.dev, /turbo run dev/)
  assert.match(rootManifest.scripts['server:bootstrap'], /dev:infra/)
})

test('the desktop owns its frontend and Tauri sources', () => {
  assert.equal(
    existsSync(path.join(repositoryRoot, 'apps/desktop/package.json')),
    true,
    'apps/desktop/package.json must exist',
  )

  const desktopManifest = readJson('apps/desktop/package.json')
  assert.equal(desktopManifest.name, '@forage/desktop')
  assert.equal(existsSync(path.join(repositoryRoot, 'apps/desktop/src')), true)
  assert.equal(existsSync(path.join(repositoryRoot, 'apps/desktop/src-tauri')), true)
})

test('the portable agent runtime is a dependency-light workspace package', () => {
  assert.equal(
    existsSync(path.join(repositoryRoot, 'packages/agent-runtime/package.json')),
    true,
    'packages/agent-runtime/package.json must exist',
  )

  const manifest = readJson('packages/agent-runtime/package.json')
  assert.equal(manifest.name, '@forage/agent-runtime')
  assert.equal(manifest.exports, './src/index.ts')
  assert.equal(existsSync(path.join(repositoryRoot, 'packages/agent-runtime/tsconfig.json')), true)

  const dependencyNames = Object.keys(manifest.dependencies ?? {})
  for (const forbidden of ['react', '@tauri-apps/api', 'fastify', 'pg']) {
    assert.equal(dependencyNames.includes(forbidden), false, `${forbidden} must not be a runtime dependency`)
  }
})

test('Turbo treats development processes as persistent and uncached', () => {
  assert.equal(existsSync(path.join(repositoryRoot, 'turbo.json')), true, 'turbo.json must exist')

  const turbo = readJson('turbo.json')
  assert.equal(turbo.tasks.dev.persistent, true)
  assert.equal(turbo.tasks.dev.cache, false)
})
