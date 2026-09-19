import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extensionSourceRequestSchema } from '@forage/agent-runtime'
import { ExtensionConfigurationStore } from '../src/configuration'
import {
  ExtensionPackageLifecycle,
  type PackageCommandRunner,
  type PackageCommandResult,
} from '../src/lifecycle'
import { inventoryExtensions } from '../src/inventory'
import { acquireManagedRevisionLeases } from '../src/leases'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forage-lifecycle-'))
  roots.push(root)
  return root
}

async function writeExtension(root: string, version = '1.0.0', options: { installScript?: boolean; missingEntry?: boolean } = {}): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'forage.extension.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'dev.example.lifecycle',
    name: 'Lifecycle fixture',
    version,
    description: 'Exercises package lifecycle behavior.',
    entry: './index.js',
    apiVersion: '1',
    contributes: { tools: [], hooks: [], settings: [] },
  }))
  if (!options.missingEntry) await writeFile(path.join(root, 'index.js'), 'export default () => {}\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'example-forage-tools', version,
    ...(options.installScript ? { scripts: { install: 'node build.js' } } : {}),
  }))
}

class FakeRunner implements PackageCommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = []
  version = '1.0.0'
  commit = 'a'.repeat(40)
  failInstall = false
  installScript = false
  missingEntry = false
  failSyntax = false
  missingCommand: string | undefined

  async run(command: string, args: readonly string[], options: { cwd?: string } = {}): Promise<PackageCommandResult> {
    this.calls.push({ command, args, cwd: options.cwd })
    if (command === this.missingCommand) throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' })
    if (command === process.execPath && this.failSyntax) throw new Error('entry syntax is invalid')
    if (command === 'npm' && args[0] === 'view') {
      return { stdout: JSON.stringify({ name: 'example-forage-tools', version: this.version }), stderr: '' }
    }
    if (command === 'npm' && args[0] === 'install' && options.cwd) {
      if (this.failInstall) throw new Error('dependency resolution failed')
      const packageRoot = args[1]?.includes('example-forage-tools')
        ? path.join(options.cwd, 'node_modules', 'example-forage-tools')
        : options.cwd
      await writeExtension(packageRoot, this.version, { installScript: this.installScript, missingEntry: this.missingEntry })
      return { stdout: 'installed', stderr: '' }
    }
    if (command === 'git' && args[0] === 'clone') {
      await writeExtension(String(args[args.length - 1]), this.version, { missingEntry: this.missingEntry })
      return { stdout: '', stderr: '' }
    }
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${this.commit}\n`, stderr: '' }
    if (command === 'git' && args[0] === 'ls-remote') return { stdout: `${this.commit}\tHEAD\n`, stderr: '' }
    return { stdout: '', stderr: '' }
  }
}

function lifecycle(root: string, runner: FakeRunner) {
  let sequence = 0
  const store = new ExtensionConfigurationStore({ root })
  return {
    store,
    service: new ExtensionPackageLifecycle({
      store,
      commandRunner: runner,
      createId: (prefix) => `${prefix}-${++sequence}`,
      validateEntry: async () => [],
    }),
  }
}

describe('Forage-owned extension package lifecycle', () => {
  it('accepts documented source forms and previews a local source without registering it', async () => {
    expect(extensionSourceRequestSchema.parse({ kind: 'npm', spec: 'npm:example-forage-tools@1.2.3' })).toBeTruthy()
    expect(extensionSourceRequestSchema.parse({ kind: 'npm', spec: '@scope/tools@next' })).toBeTruthy()
    expect(extensionSourceRequestSchema.parse({ kind: 'git', url: 'ssh://git@example.com/tools.git', ref: 'v1.2.3' })).toBeTruthy()
    expect(extensionSourceRequestSchema.parse({ kind: 'git', url: 'git@example.com:team/tools.git' })).toBeTruthy()
    expect(extensionSourceRequestSchema.safeParse({ kind: 'git', url: 'file:///tmp/tools' }).success).toBe(false)

    const root = await temporaryRoot()
    const source = path.join(root, 'source')
    await writeExtension(source)
    const runner = new FakeRunner()
    const { store, service } = lifecycle(path.join(root, '.forage'), runner)
    const preview = await service.preview({ kind: 'local', path: source })

    expect(preview.entry.manifest?.id).toBe('dev.example.lifecycle')
    expect((await store.read()).sources).toEqual([])
    expect(runner.calls).toEqual([])
    const installationId = await service.install(preview.requestedSource, preview.previewId)
    const configured = (await store.read()).sources[0]
    expect(configured).toMatchObject({ installationId, enabled: false, trust: { accepted: false }, settings: {} })
    expect(await readFile(path.join(source, 'index.js'), 'utf8')).toContain('export default')
  })

  it('keeps an incompatible Forage manifest inspectable but prevents registration', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'future-source')
    await writeExtension(source)
    const manifestPath = path.join(source, 'forage.extension.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, JSON.stringify({ ...manifest, apiVersion: '2' }))
    const { store, service } = lifecycle(path.join(root, '.forage'), new FakeRunner())

    const preview = await service.preview({ kind: 'local', path: source })
    expect(preview.entry).toMatchObject({ status: 'incompatible', inspection: { apiVersion: '2' } })
    await expect(service.install(preview.requestedSource, preview.previewId)).rejects.toThrow('not installable')
    expect((await store.read()).sources).toEqual([])
  })

  it('stages npm dependencies with scripts disabled and atomically registers a disabled revision', async () => {
    const root = await temporaryRoot()
    const runner = new FakeRunner()
    const { store, service } = lifecycle(path.join(root, '.forage'), runner)
    const requested = { kind: 'npm' as const, spec: 'npm:example-forage-tools@1.0.0' }
    const preview = await service.preview(requested)

    expect((await store.read()).sources).toEqual([])
    expect(preview.entry.source).toMatchObject({ kind: 'npm', resolvedVersion: '1.0.0' })
    expect(runner.calls.find((call) => call.args[0] === 'install')?.args).toContain('--ignore-scripts')

    const installationId = await service.install(requested, preview.previewId)
    const configured = (await store.read()).sources[0]
    expect(configured).toMatchObject({
      installationId,
      source: requested,
      enabled: false,
      trust: { accepted: false },
      settings: {},
      resolvedSource: { kind: 'npm', resolvedVersion: '1.0.0' },
    })
    expect((await stat(configured.resolvedSource!.canonicalPath)).isDirectory()).toBe(true)
  })

  it('reports missing prerequisites and rejects packages that declare install scripts', async () => {
    const root = await temporaryRoot()
    const runner = new FakeRunner()
    runner.missingCommand = 'npm'
    const first = lifecycle(path.join(root, '.forage-a'), runner)
    await expect(first.service.preview({ kind: 'npm', spec: 'example-forage-tools' }))
      .rejects.toThrow('Required executable “npm” is not available')
    expect((await first.store.read()).sources).toEqual([])

    const missingGit = new FakeRunner()
    missingGit.missingCommand = 'git'
    const gitStore = lifecycle(path.join(root, '.forage-git'), missingGit)
    await expect(gitStore.service.preview({ kind: 'git', url: 'https://example.com/tools.git' }))
      .rejects.toThrow('Required executable “git” is not available')
    expect((await gitStore.store.read()).sources).toEqual([])

    const scripts = new FakeRunner()
    scripts.installScript = true
    const second = lifecycle(path.join(root, '.forage-b'), scripts)
    await expect(second.service.preview({ kind: 'npm', spec: 'example-forage-tools' }))
      .rejects.toThrow('unsupported lifecycle script(s): install')
    expect((await second.store.read()).sources).toEqual([])

    const dependencyFailure = new FakeRunner()
    dependencyFailure.failInstall = true
    const third = lifecycle(path.join(root, '.forage-c'), dependencyFailure)
    await expect(third.service.preview({ kind: 'npm', spec: 'example-forage-tools' }))
      .rejects.toThrow('dependency resolution failed')
    expect((await third.store.read()).sources).toEqual([])

    const invalidEntry = new FakeRunner()
    invalidEntry.failSyntax = true
    const fourth = lifecycle(path.join(root, '.forage-d'), invalidEntry)
    await expect(fourth.service.preview({ kind: 'npm', spec: 'example-forage-tools' }))
      .rejects.toThrow('entry syntax is invalid')
    expect((await fourth.store.read()).sources).toEqual([])
  })

  it('resolves Git commits and keeps explicit refs pinned without remote checks', async () => {
    const root = await temporaryRoot()
    const runner = new FakeRunner()
    const { store, service } = lifecycle(path.join(root, '.forage'), runner)
    const requested = { kind: 'git' as const, url: 'https://example.com/forage-tools.git', ref: 'v1.0.0' }
    const preview = await service.preview(requested)
    expect(preview.entry.source).toMatchObject({ kind: 'git', requestedRef: 'v1.0.0', resolvedCommit: runner.commit })
    const installationId = await service.install(requested, preview.previewId)
    const configured = (await store.read()).sources.find((source) => source.installationId === installationId)!
    const callsBeforeCheck = runner.calls.length
    expect(await service.checkForUpdate(configured)).toEqual({ available: false, revision: runner.commit })
    expect(runner.calls).toHaveLength(callsBeforeCheck)
  })

  it('keeps pins fixed and preserves the last working revision when an update fails', async () => {
    const root = await temporaryRoot()
    const runner = new FakeRunner()
    const { store, service } = lifecycle(path.join(root, '.forage'), runner)
    const pinned = { kind: 'npm' as const, spec: 'example-forage-tools@1.0.0' }
    const preview = await service.preview(pinned)
    const installationId = await service.install(pinned, preview.previewId)
    const original = (await store.read()).sources[0]
    const callsBeforeCheck = runner.calls.length
    expect(await service.checkForUpdate(original)).toEqual({ available: false, revision: '1.0.0' })
    expect(runner.calls).toHaveLength(callsBeforeCheck)

    await store.mutate((draft) => { draft.sources[0].source = { kind: 'npm', spec: 'example-forage-tools@latest' } })
    runner.version = '2.0.0'
    runner.missingEntry = true
    const unpinned = (await store.read()).sources.find((source) => source.installationId === installationId)!
    await expect(service.update(unpinned)).rejects.toThrow('declared extension entry does not exist')
    const after = (await store.read()).sources[0]
    expect(after.resolvedSource).toEqual(original.resolvedSource)
    expect((await stat(after.resolvedSource!.canonicalPath)).isDirectory()).toBe(true)
  })

  it('retains the prior immutable revision after update and only deletes managed sources on removal', async () => {
    const root = await temporaryRoot()
    const runner = new FakeRunner()
    const { store, service } = lifecycle(path.join(root, '.forage'), runner)
    const requested = { kind: 'npm' as const, spec: 'example-forage-tools@latest' }
    const preview = await service.preview(requested)
    const installationId = await service.install(requested, preview.previewId)
    const original = (await store.read()).sources[0]
    const oldPath = original.resolvedSource!.canonicalPath
    const catalog = await inventoryExtensions({ configurationRoot: store.root })
    const catalogEntry = catalog.entries[0]
    const lease = await acquireManagedRevisionLeases(store.root, {
      version: 1,
      catalogRevision: catalog.revision,
      configurationRevision: (await store.read()).revision,
      sources: [{
        installationId,
        extensionId: catalogEntry.manifest!.id,
        sourceRevision: catalogEntry.provenance!.sourceRevision,
        entryDigest: catalogEntry.provenance!.entryDigest!,
        toolIds: [], hooks: [],
      }],
    }, catalog)

    runner.version = '2.0.0'
    await service.update(original)
    const updated = (await store.read()).sources[0]
    expect(updated.resolvedSource).toMatchObject({ kind: 'npm', resolvedVersion: '2.0.0' })
    expect(updated.resolvedSource!.canonicalPath).not.toBe(oldPath)
    expect((await stat(oldPath)).isDirectory()).toBe(true)
    await lease.release()
    await expect(stat(oldPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const updatedCatalog = await inventoryExtensions({ configurationRoot: store.root })
    const updatedEntry = updatedCatalog.entries[0]
    const removalLease = await acquireManagedRevisionLeases(store.root, {
      version: 1,
      catalogRevision: updatedCatalog.revision,
      configurationRevision: (await store.read()).revision,
      sources: [{
        installationId,
        extensionId: updatedEntry.manifest!.id,
        sourceRevision: updatedEntry.provenance!.sourceRevision,
        entryDigest: updatedEntry.provenance!.entryDigest!,
        toolIds: [], hooks: [],
      }],
    }, updatedCatalog)
    await service.remove(updated)
    expect((await stat(path.join(store.packagesPath, installationId))).isDirectory()).toBe(true)
    await removalLease.release()
    await expect(stat(path.join(store.packagesPath, installationId))).rejects.toMatchObject({ code: 'ENOENT' })

    const localPath = path.join(root, 'external-local')
    await writeExtension(localPath)
    const localPreview = await service.preview({ kind: 'local', path: localPath })
    const localId = await service.install(localPreview.requestedSource, localPreview.previewId)
    const local = (await store.read()).sources.find((source) => source.installationId === localId)!
    await service.remove(local)
    expect((await stat(localPath)).isDirectory()).toBe(true)
  })

  it('never invokes package commands during inventory, refresh-equivalent reads, or missing-resource inspection', async () => {
    const root = await temporaryRoot()
    const runner = new FakeRunner()
    const configurationRoot = path.join(root, '.forage')
    const { store } = lifecycle(configurationRoot, runner)
    await store.mutate((draft) => {
      draft.sources.push({
        installationId: 'managed-missing',
        source: { kind: 'npm', spec: 'example-forage-tools@latest' },
        resolvedSource: {
          kind: 'npm', installationId: 'managed-missing', spec: 'example-forage-tools@latest',
          resolvedVersion: '1.0.0', canonicalPath: path.join(configurationRoot, 'packages/managed-missing/revisions/old/node_modules/example-forage-tools'),
        },
        enabled: false, trust: { accepted: false }, settings: {},
      })
    })

    const catalog = await inventoryExtensions({ configurationRoot })
    expect(catalog.entries[0]).toMatchObject({ status: 'error', diagnostics: [{ code: 'missing_manifest' }] })
    expect(runner.calls).toEqual([])
  })
})
