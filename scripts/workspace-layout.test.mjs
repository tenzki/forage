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
  const workspace = readFileSync(path.join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')

  assert.equal(rootManifest.name, '@forage/workspace')
  assert.equal(rootManifest.packageManager.startsWith('pnpm@'), true)
  assert.equal('workspaces' in rootManifest, false)
  assert.match(workspace, /- apps\/\*/)
  assert.match(workspace, /- packages\/\*/)
  assert.match(workspace, /- apps\/desktop\/src-tauri\/resources\/pi\/sidecar/)
  assert.equal(existsSync(path.join(repositoryRoot, 'package-lock.json')), false)
  assert.equal(
    existsSync(path.join(repositoryRoot, 'apps/desktop/src-tauri/resources/pi/sidecar/package-lock.json')),
    false,
  )
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

test('extensions have isolated workspace projects and Node test environments', () => {
  const apiManifest = readJson('packages/extension-api/package.json')
  const hostManifest = readJson('packages/extension-host/package.json')
  const extensionsManifest = readJson('packages/extensions/package.json')
  const rootVitest = readFileSync(path.join(repositoryRoot, 'vitest.config.ts'), 'utf8')
  const apiVitest = readFileSync(path.join(repositoryRoot, 'packages/extension-api/vitest.config.ts'), 'utf8')
  const hostVitest = readFileSync(path.join(repositoryRoot, 'packages/extension-host/vitest.config.ts'), 'utf8')
  const extensionsVitest = readFileSync(path.join(repositoryRoot, 'packages/extensions/vitest.config.ts'), 'utf8')
  const sidecarManifest = readJson('apps/desktop/src-tauri/resources/pi/sidecar/package.json')

  assert.equal(apiManifest.name, '@forage/extension-api')
  assert.equal(apiManifest.private, true)
  assert.equal(hostManifest.name, '@forage/extension-host')
  assert.equal(hostManifest.private, true)
  assert.equal(hostManifest.dependencies['@forage/agent-runtime'], 'workspace:*')
  assert.equal(hostManifest.dependencies['@forage/extension-api'], 'workspace:*')
  assert.equal(extensionsManifest.name, '@forage/extensions')
  assert.equal(extensionsManifest.private, true)
  assert.equal(extensionsManifest.dependencies['@forage/extension-api'], 'workspace:*')
  assert.equal(sidecarManifest.dependencies['@forage/extension-host'], 'workspace:*')
  assert.equal(sidecarManifest.dependencies['@forage/agent-runtime'], 'workspace:*')
  assert.equal(typeof sidecarManifest.scripts.build, 'string')
  assert.equal(typeof sidecarManifest.scripts.typecheck, 'string')

  for (const manifest of [apiManifest, hostManifest, extensionsManifest]) {
    assert.equal(typeof manifest.scripts.build, 'string')
    assert.equal(typeof manifest.scripts.typecheck, 'string')
    assert.equal(typeof manifest.scripts.test, 'string')
  }

  assert.match(apiVitest, /environment: 'node'/)
  assert.match(hostVitest, /environment: 'node'/)
  assert.match(extensionsVitest, /environment: 'node'/)
  assert.match(rootVitest, /packages\/extension-api\/\*\*/)
  assert.match(rootVitest, /packages\/extension-host\/\*\*/)
  assert.match(rootVitest, /packages\/extensions\/\*\*/)
  assert.match(rootVitest, /resources\/pi\/sidecar\/\*\*/)
  assert.equal(existsSync(path.join(repositoryRoot, 'packages/extensions/forage.extension.json')), true)
})

test('Turbo treats development processes as persistent and uncached', () => {
  assert.equal(existsSync(path.join(repositoryRoot, 'turbo.json')), true, 'turbo.json must exist')

  const turbo = readJson('turbo.json')
  assert.equal(turbo.tasks.dev.persistent, true)
  assert.equal(turbo.tasks.dev.cache, false)
})
