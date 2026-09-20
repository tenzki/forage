import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionConfigurationStore } from '../src/configuration'
import { ExtensionManagementService } from '../src/management'

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((item) => rm(item, { recursive: true, force: true }))))

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'forage-management-'))
  temporaryDirectories.push(root)
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'dist'), { recursive: true })
  await writeFile(path.join(source, 'forage.extension.json'), JSON.stringify({
    id: 'dev.example.management', name: 'Management', version: '1.0.0',
    description: 'Management fixture.', entry: './dist/index.mjs',
    contributes: { tools: [], hooks: [], settings: [] },
  }))
  await writeFile(path.join(source, 'dist/index.mjs'), 'export default () => undefined')
  const store = new ExtensionConfigurationStore({ root, createInstallationId: () => 'installation-management' })
  await store.registerLocalSource(source)
  return { root, store }
}

const request = (operation: string, extra: Record<string, unknown> = {}) => ({
  version: 1, kind: 'request', requestId: `request-${operation}`, operation, ...extra,
})

describe('credential-free extension management service', () => {
  it('routes correlated concurrent requests and supports validation, activation, status, reload, disable, and remove', async () => {
    const { root } = await setup()
    const validator = vi.fn(async () => [])
    const service = new ExtensionManagementService({ configurationRoot: root, validateEntry: validator })
    const inventory = await service.handle(request('inventory'))
    expect(inventory).toMatchObject({
      requestId: 'request-inventory', operation: 'inventory', ok: true,
      configuration: { version: 1, revision: 1 },
      extensionsDirectory: root.split(path.sep).join('/') + '/extensions',
    })

    const [validated, status] = await Promise.all([
      service.handle(request('validate', { installationId: 'installation-management' })),
      service.handle(request('configuration_status', { installationId: 'installation-management' })),
    ])
    expect(validated).toMatchObject({ requestId: 'request-validate', ok: true })
    expect(status).toMatchObject({ requestId: 'request-configuration_status', ok: true })

    expect(await service.handle(request('configure', {
      installationId: 'installation-management', settings: {}, secretReferences: {},
    }))).toMatchObject({ ok: true, entry: { status: 'needs_review' } })

    expect(await service.handle(request('enable', { installationId: 'installation-management', trustAccepted: true })))
      .toMatchObject({ ok: true, entry: { status: 'ready' } })
    expect(await service.handle(request('reload', { installationId: 'installation-management' })))
      .toMatchObject({ ok: true, entry: { status: 'ready' } })
    expect(await service.handle(request('disable', { installationId: 'installation-management' })))
      .toMatchObject({ ok: true, entry: { status: 'disabled' } })
    expect(await service.handle(request('remove', { installationId: 'installation-management' })))
      .toMatchObject({ ok: true, removedInstallationId: 'installation-management' })
    expect(validator).toHaveBeenCalled()
  })

  it('registers a local source without trusting or enabling it', async () => {
    const { root, store } = await setup()
    await store.mutate((draft) => { draft.sources = [] })
    const service = new ExtensionManagementService({ configurationRoot: root })
    const response = await service.handle(request('install', { source: { kind: 'local', path: path.join(root, 'source') } }))
    expect(response).toMatchObject({ ok: true, entry: { status: 'needs_review' } })
    const saved = await store.read()
    expect(saved.sources[0]).toMatchObject({ enabled: false, trust: { accepted: false }, settings: {} })
  })

  it('previews a source before registration and installs the exact preview without enabling it', async () => {
    const { root, store } = await setup()
    await store.mutate((draft) => { draft.sources = [] })
    const service = new ExtensionManagementService({
      configurationRoot: root,
      createLifecycleId: () => 'preview-management',
    })
    const source = { kind: 'local', path: path.join(root, 'source') }
    const preview = await service.handle(request('preview_install', { source }))
    expect(preview).toMatchObject({
      ok: true,
      preview: { previewId: 'preview-management', requestedSource: source, entry: { status: 'needs_review' } },
    })
    expect((await store.read()).sources).toEqual([])
    expect(await service.handle(request('install', { source, previewId: 'preview-management' })))
      .toMatchObject({ ok: true, entry: { status: 'needs_review' } })
    expect((await store.read()).sources[0]).toMatchObject({ enabled: false, trust: { accepted: false }, settings: {} })
  })

  it('bounds validation time and rejects Update for local-directory sources', async () => {
    const { root } = await setup()
    const service = new ExtensionManagementService({
      configurationRoot: root,
      validationTimeoutMs: 10,
      validateEntry: async (_entry, _configuration, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve([]), { once: true })
      }),
    })
    expect(await service.handle(request('validate', { installationId: 'installation-management' })))
      .toMatchObject({ ok: false, diagnostics: [{ code: 'validation_timeout' }] })
    expect(await service.handle(request('update', { installationId: 'installation-management' })))
      .toMatchObject({ ok: false, diagnostics: [{ code: 'management_operation_failed' }] })
  })

  it('does not run npm or Git during inventory, validation, activation, reload, or configuration reads', async () => {
    const { root } = await setup()
    const commandRunner = { run: vi.fn(async () => ({ stdout: '', stderr: '' })) }
    const service = new ExtensionManagementService({
      configurationRoot: root,
      commandRunner,
      validateEntry: async () => [],
    })
    await service.handle(request('inventory'))
    await service.handle(request('validate', { installationId: 'installation-management' }))
    await service.handle(request('configuration_status', { installationId: 'installation-management' }))
    await service.handle(request('enable', { installationId: 'installation-management', trustAccepted: true }))
    await service.handle(request('reload', { installationId: 'installation-management' }))
    expect(commandRunner.run).not.toHaveBeenCalled()
  })
})
