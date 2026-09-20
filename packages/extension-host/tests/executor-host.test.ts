import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionConfiguration, ExtensionSkillContextSnapshot } from '@forage/agent-runtime'
import { ExtensionExecutorHost } from '../src/executor-host'
import { NodeExtensionExecutorProcess, credentialFreeExecutorEnvironment } from '../src/executor-process'
import { inventoryExtensions } from '../src/inventory'

const roots: string[] = []
const workerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../apps/desktop/src-tauri/resources/pi/sidecar/executor-worker.ts',
)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(executionDeadlineMs = 1_000) {
  const root = await mkdtemp(path.join(tmpdir(), 'forage-executor-host-'))
  roots.push(root)
  const source = path.join(root, 'extension')
  await mkdir(source)
  const configurationForm = {
    fields: [
      { key: 'mode', label: 'Mode', type: 'choice', options: [
        { value: 'ok', label: 'OK' },
        { value: 'outside-plan', label: 'Outside plan' },
        { value: 'outside-result', label: 'Outside result' },
        { value: 'mutate-plan', label: 'Mutate plan' },
        { value: 'fail', label: 'Fail' },
        { value: 'hang', label: 'Hang' },
      ] },
      { key: 'prefix', label: 'Prefix', type: 'text' },
    ],
  }
  const manifest = {
    id: 'dev.example.generic-executor', name: 'Generic executor', version: '1.0.0',
    description: 'Deterministic executor process fixture.', entry: './index.mjs',
    contributes: {
      tools: [{ id: 'unrelated_tool', name: 'Unrelated', description: 'Must not execute.' }],
      hooks: ['run:start'],
      settings: [
        { key: 'device_prefix', label: 'Device prefix', type: 'string' },
        { key: 'token', label: 'Token', type: 'secret' },
      ],
      executors: [{
        id: 'label', name: 'Label', description: 'Labels one note.', allowEmptyPrompt: true,
        configuration: configurationForm,
      }],
    },
  }
  await writeFile(path.join(source, 'forage.extension.json'), JSON.stringify(manifest))
  await writeFile(path.join(source, 'index.mjs'), `
export default host => {
  host.registerTool({ id: 'unrelated_tool', name: 'Unrelated', description: 'Must not execute.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { throw new Error('unrelated tool executed') }
  })
  host.on('run:start', () => { throw new Error('unrelated hook executed') })
  host.registerSkillExecutor({
    id: 'label', name: 'Label', description: 'Labels one note.', allowEmptyPrompt: true,
    configuration: ${JSON.stringify(configurationForm)},
    async validateConfiguration(input) {
      if (process.env.OPENAI_API_KEY || process.env.CODEX_TOKEN || process.env.UNRELATED_SECRET) {
        return { valid: false, issues: [{ path: [], message: 'inference credential leaked' }] }
      }
      return input.configuration.prefix ? { valid: true } : {
        valid: false, issues: [{ path: ['prefix'], message: 'Prefix is required.' }]
      }
    },
    async prepare(input, context) {
      context.reportProgress({ message: 'Prepared input', completed: 1, total: 1 })
      const id = input.configuration.mode === 'outside-plan' ? 'outside' : 'candidate'
      return { selectedNodeIds: [id], requestedReferenceIds: [id],
        annotations: [{ nodeId: id, kind: 'selected', label: 'Selected note' }],
        data: { prefix: input.configuration.prefix, preparedText: input.context.roots[0].text }
      }
    },
    async execute(input, context) {
      if (input.configuration.mode === 'hang') await new Promise(() => setInterval(() => {}, 1000))
      if (input.configuration.mode === 'mutate-plan') input.plan.selectedNodeIds[0] = 'outside'
      if (context.secrets.unrelated !== undefined) throw new Error('unrelated secret was exposed')
      context.log({ level: 'info', message: 'token=' + context.secrets.token,
        data: { nested: [{ [context.secrets.token]: 'value ' + context.secrets.token }], numeric: 42 } })
      context.reportProgress({ message: 'using ' + context.secrets.token, completed: 1, total: 1 })
      if (input.configuration.mode === 'fail') throw new Error('failed ' + context.secrets.token)
      const nodeId = input.configuration.mode === 'outside-result' ? 'outside' : input.plan.selectedNodeIds[0]
      return { nodes: [{ type: 'text', segments: [
        { type: 'text', text: context.settings.device_prefix + ':' + input.plan.data.prefix + ':' + input.plan.data.preparedText + ':' },
        { type: 'internal-reference', nodeId, label: 'Candidate' }
      ] }] }
    }
  })
}
`)
  const sourceConfiguration = {
    installationId: 'generic-executor', source: { kind: 'local' as const, path: source }, enabled: true,
    trust: { accepted: true as const, extensionId: manifest.id }, settings: { device_prefix: 'device' },
    secretReferences: { token: 'forage-extension/generic-executor/token' },
  }
  const localConfiguration: ExtensionConfiguration = { version: 1, revision: 7, sources: [sourceConfiguration] }
  const catalog = await inventoryExtensions({ configurationRoot: root, configuration: localConfiguration })
  const context: ExtensionSkillContextSnapshot = {
    prompt: '', invocation: { id: 'invocation', text: '/label', documentOrder: 2 },
    roots: [{ id: 'candidate', text: 'Original note', documentOrder: 1 }],
    provenance: { ancestorPathIds: [], explicitLinkedRootIds: [] },
  }
  const runner = new NodeExtensionExecutorProcess({
    workerPath,
    nodeArguments: ['--import', 'tsx'],
    environment: credentialFreeExecutorEnvironment({
      ...process.env,
      OPENAI_API_KEY: 'must-not-leak',
      CODEX_TOKEN: 'must-not-leak',
      UNRELATED_SECRET: 'must-not-leak',
    }),
    executionDeadlineMs,
    terminationGraceMs: 20,
  })
  return { root, source, localConfiguration, catalog, context, runner }
}

async function admit(mode = 'ok', executionDeadlineMs = 1_000) {
  const value = await fixture(executionDeadlineMs)
  const host = new ExtensionExecutorHost(value.runner)
  const progress: string[] = []
  const admission = await host.admit({
    catalog: value.catalog,
    localConfiguration: value.localConfiguration,
    configurationRoot: value.root,
    portableConfigurationRevision: 91,
    executor: { extensionId: 'dev.example.generic-executor', executorId: 'label' },
    runId: 'run-generic',
    configuration: { mode, prefix: 'portable' },
    context: value.context,
    hostAdmittedReferenceIds: ['candidate'],
  }, { signal: new AbortController().signal, onProgress: (event) => progress.push(event.message) })
  return { ...value, admission, progress }
}

describe('generic executor process host', () => {
  it('validates and prepares without inference credentials, pins independent revisions, and executes the exact admitted plan', async () => {
    const value = await admit()
    expect(value.admission.portableConfigurationRevision).toBe(91)
    expect(value.admission.executorSnapshot.configurationRevision).toBe(7)
    expect(value.admission.plan).toMatchObject({ selectedNodeIds: ['candidate'], admittedReferenceIds: ['candidate'] })
    expect(value.progress).toContain('Prepared input')
    expect(Object.isFrozen(value.admission.context.roots[0])).toBe(true)

    ;(value.context.roots[0] as { text: string }).text = 'Changed after admission'
    const logs: Array<{ message: string; data?: unknown }> = []
    const activity: string[] = []
    const token = 'synthetic-"secret\\with-newline\n'
    const result = await value.admission.execute({
      signal: new AbortController().signal,
      secrets: { token, unrelated: 'must-not-arrive' },
      onLog: (event) => logs.push(event),
      onProgress: (event) => activity.push(event.message),
    })
    expect(result.nodes[0]).toMatchObject({ segments: [
      { type: 'text', text: 'device:portable:Original note:' },
      { type: 'internal-reference', nodeId: 'candidate', label: 'Candidate' },
    ] })
    expect(logs[0]).toMatchObject({
      message: 'token=[REDACTED]',
      data: { nested: [{ '[REDACTED]': 'value [REDACTED]' }], numeric: 42 },
    })
    expect(activity).toEqual(['using [REDACTED]'])
    expect(JSON.stringify({ logs, activity })).not.toContain(token)
    await expect(value.admission.execute({ signal: new AbortController().signal })).rejects.toMatchObject({ code: 'executor_already_executed' })
    await value.admission.release()
  })

  it('rejects selected or annotated IDs outside the host snapshot before execution', async () => {
    const value = await fixture()
    const host = new ExtensionExecutorHost(value.runner)
    await expect(host.admit({
      catalog: value.catalog, localConfiguration: value.localConfiguration, configurationRoot: value.root,
      portableConfigurationRevision: 1, executor: { extensionId: 'dev.example.generic-executor', executorId: 'label' },
      runId: 'run-outside', configuration: { mode: 'outside-plan', prefix: 'x' }, context: value.context,
      hostAdmittedReferenceIds: ['candidate'],
    }, { signal: new AbortController().signal })).rejects.toThrow(/outside the host context snapshot/i)
  })

  it('validates results only against host-admitted references and preserves typed values while sanitizing failures', async () => {
    const outside = await admit('outside-result')
    await expect(outside.admission.execute({ signal: new AbortController().signal, secrets: { token: 'synthetic' } }))
      .rejects.toMatchObject({ code: 'invalid_executor_result' })
    await outside.admission.release()

    const failed = await admit('fail')
    const token = 'synthetic-"secret\\line\n'
    await expect(failed.admission.execute({ signal: new AbortController().signal, secrets: { token } }))
      .rejects.toMatchObject({ code: 'executor_execution_failed', message: 'failed [REDACTED]' })
    await failed.admission.release()
  })

  it('does not let executor code mutate the pinned configuration, context, or admitted plan', async () => {
    const value = await admit('mutate-plan')
    await expect(value.admission.execute({ signal: new AbortController().signal, secrets: { token: 'synthetic' } }))
      .rejects.toMatchObject({ code: 'executor_execution_failed' })
    expect(value.admission.plan.selectedNodeIds).toEqual(['candidate'])
    await value.admission.release()
  })

  it('terminates an executor that ignores its deadline and rejects late completion', async () => {
    const value = await admit('hang', 80)
    await expect(value.admission.execute({ signal: new AbortController().signal, secrets: { token: 'synthetic' } }))
      .rejects.toMatchObject({ code: 'executor_deadline_exceeded' })
    await value.admission.release()
  })

  it('verifies the admitted source digest again before direct execution', async () => {
    const value = await admit()
    await writeFile(path.join(value.source, 'index.mjs'), 'export default () => undefined\n')
    await expect(value.admission.execute({ signal: new AbortController().signal, secrets: { token: 'synthetic' } }))
      .rejects.toMatchObject({ code: 'stale_extension_revision' })
    await value.admission.release()
  })

  it('propagates cancellation, applies the termination grace, and ignores any late worker result', async () => {
    const value = await admit('hang')
    const controller = new AbortController()
    const execution = value.admission.execute({ signal: controller.signal, secrets: { token: 'synthetic' } })
    setTimeout(() => controller.abort(new Error('cancelled by user')), 30)
    await expect(execution).rejects.toMatchObject({ code: 'executor_cancelled' })
    await value.admission.release()
  })
})
