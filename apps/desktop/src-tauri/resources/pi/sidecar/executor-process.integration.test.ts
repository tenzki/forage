import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionConfiguration } from '@forage/agent-runtime'
import { ExtensionExecutorHost, type NodeExtensionExecutorProcess } from '@forage/extension-host'
import { inventoryExtensions } from '@forage/extension-host'

const roots: string[] = []
const sidecarRoot = path.dirname(fileURLToPath(import.meta.url))

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('packaged generic executor sidecar process', () => {
  it('validates, prepares, and directly executes a self-contained fixture through packaged entries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forage-packaged-executor-'))
    roots.push(root)
    const extensionRoot = path.join(root, 'fixture')
    await mkdir(extensionRoot)
    const form = { fields: [{ key: 'prefix', label: 'Prefix', type: 'text', required: true }] }
    await writeFile(path.join(extensionRoot, 'forage.extension.json'), JSON.stringify({
      id: 'dev.example.packaged-executor', name: 'Packaged executor', version: '1.0.0',
      description: 'Self-contained packaged executor fixture.', entry: './index.mjs',
      contributes: { tools: [], hooks: [], settings: [], executors: [{
        id: 'label', name: 'Label', description: 'Labels the first note.', configuration: form,
      }] },
    }))
    await writeFile(path.join(extensionRoot, 'index.mjs'), `export default host => host.registerSkillExecutor({
      id: 'label', name: 'Label', description: 'Labels the first note.', configuration: ${JSON.stringify(form)},
      async validateConfiguration() { return { valid: true } },
      async prepare(input) { const id = input.context.roots[0].id; return {
        selectedNodeIds: [id], requestedReferenceIds: [id], annotations: [{ nodeId: id, kind: 'selected', label: 'First note' }],
        data: { prefix: input.configuration.prefix }
      } },
      async execute(input) { return { nodes: [{ type: 'text', segments: [
        { type: 'text', text: input.plan.data.prefix + ': ' },
        { type: 'internal-reference', nodeId: input.plan.selectedNodeIds[0], label: input.context.roots[0].text }
      ] }] } }
    })\n`)
    const source = {
      installationId: 'packaged-fixture', source: { kind: 'local' as const, path: extensionRoot }, enabled: true,
      trust: { accepted: true as const, extensionId: 'dev.example.packaged-executor' }, settings: {},
    }
    const localConfiguration: ExtensionConfiguration = { version: 1, revision: 23, sources: [source] }
    const catalog = await inventoryExtensions({ configurationRoot: root, configuration: localConfiguration })
    const packagedModule = await import(`${pathToFileURL(path.join(sidecarRoot, 'dist/executor-process.mjs')).href}?integration`) as {
      createSidecarExtensionExecutorProcess(): NodeExtensionExecutorProcess
    }
    const host = new ExtensionExecutorHost(packagedModule.createSidecarExtensionExecutorProcess())
    const admission = await host.admit({
      catalog,
      localConfiguration,
      configurationRoot: root,
      portableConfigurationRevision: 701,
      executor: { extensionId: 'dev.example.packaged-executor', executorId: 'label' },
      runId: 'packaged-executor-run',
      configuration: { prefix: 'Packaged' },
      context: {
        prompt: '', invocation: { id: 'invocation', text: '/label', documentOrder: 3 },
        roots: [
          { id: 'alpha', text: 'Alpha note', documentOrder: 1 },
          { id: 'beta', text: 'Beta note', documentOrder: 2 },
        ],
        provenance: { ancestorPathIds: [], explicitLinkedRootIds: [] },
      },
      hostAdmittedReferenceIds: ['alpha', 'beta'],
    }, { signal: new AbortController().signal })

    expect(admission.executorSnapshot.configurationRevision).toBe(23)
    expect(admission.portableConfigurationRevision).toBe(701)
    expect(admission.plan.selectedNodeIds).toEqual(['alpha'])
    await expect(admission.execute({ signal: new AbortController().signal })).resolves.toMatchObject({
      nodes: [{ segments: [
        { type: 'text', text: 'Packaged: ' },
        { type: 'internal-reference', nodeId: 'alpha', label: 'Alpha note' },
      ] }],
    })
    await admission.release()

    const child = spawn(process.execPath, [path.join(sidecarRoot, 'dist/executor.mjs')], {
      cwd: sidecarRoot,
      env: { ...process.env, FORAGE_CONFIGURATION_ROOT: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    await expect(lines.next()).resolves.toMatchObject({ value: JSON.stringify({ version: 1, kind: 'ready' }) })
    child.stdin.write(`${JSON.stringify({
      version: 1, kind: 'request', requestId: 'admit-one', operation: 'admit', input: {
        catalog, localConfiguration, portableConfigurationRevision: 702,
        executor: { extensionId: 'dev.example.packaged-executor', executorId: 'label' },
        runId: 'packaged-protocol-run', configuration: { prefix: 'Preview' },
        context: {
          prompt: '', invocation: { id: 'invocation', text: '/label', documentOrder: 3 },
          roots: [{ id: 'alpha', text: 'Alpha note', documentOrder: 1 }],
          provenance: { ancestorPathIds: [], explicitLinkedRootIds: [] },
        },
        hostAdmittedReferenceIds: ['alpha'],
      },
    })}\n`)
    const response = JSON.parse((await lines.next()).value!) as Record<string, unknown>
    expect(response).toMatchObject({ kind: 'response', requestId: 'admit-one', operation: 'admit', ok: true, portableConfigurationRevision: 702 })
    expect(response.plan).toMatchObject({ selectedNodeIds: ['alpha'], admittedReferenceIds: ['alpha'] })
    child.stdin.write(`${JSON.stringify({ version: 1, kind: 'request', requestId: 'release-one', operation: 'release', admissionId: response.admissionId })}\n`)
    await expect(lines.next()).resolves.toMatchObject({ value: expect.stringContaining('"requestId":"release-one"') })
    child.kill('SIGTERM')
  })
})
