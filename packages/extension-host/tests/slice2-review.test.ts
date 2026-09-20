import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ExtensionConfiguration, ExtensionSkillExecutionInput } from '@forage/agent-runtime'
import { inventoryExtensions } from '../src/inventory'
import { loadForageExtension, validateForageExtensionEntry } from '../src/runtime'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function fixture(reordered = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'forage-review-'))
  roots.push(root)
  const source = path.join(root, 'source')
  await mkdir(source)
  const form = { fields: [{ key: 'prefix', label: 'Prefix', type: 'text' }] }
  const manifest = {
    id: 'dev.example.review', name: 'Review', version: '1.0.0', description: 'Test', entry: './index.mjs',
    contributes: { tools: [], hooks: [], settings: [{ key: 'token', label: 'Token', type: 'secret' }], executors: [{
      id: 'summarize', name: 'Summarize', description: 'Test executor', configuration: form,
    }] },
  }
  const runtimeForm = reordered ? { fields: [{ label: 'Prefix', type: 'text', key: 'prefix' }] } : form
  await writeFile(path.join(source, 'forage.extension.json'), JSON.stringify(manifest))
  await writeFile(path.join(source, 'index.mjs'), `export default host => host.registerSkillExecutor({
    id: 'summarize', name: 'Summarize', description: 'Test executor', configuration: ${JSON.stringify(runtimeForm)},
    async validateConfiguration() { return { valid: true } },
    async prepare() { return { selectedNodeIds: ['candidate'], requestedReferenceIds: ['candidate'], annotations: [], data: {} } },
    async execute(input, context) {
      context.log({ level: 'info', message: context.secrets.token, data: { token: context.secrets.token, nested: [{ [context.secrets.token]: 'prefix ' + context.secrets.token + ' suffix' }], numeric: 42 } });
      context.reportProgress({ message: context.secrets.token, completed: 1, total: 1 });
      if (context.secrets.token.startsWith('throw-')) throw new Error('failed with ' + context.secrets.token);
      return { nodes: [{ type: 'text', segments: [{ type: 'internal-reference', nodeId: 'candidate', label: 'Candidate' }] }] };
    }
  })`)
  const configuration: ExtensionConfiguration = { version: 1, revision: 1, sources: [{
    installationId: 'review', source: { kind: 'local', path: source }, enabled: true,
    trust: { accepted: true, extensionId: manifest.id }, settings: {}, secretReferences: { token: 'forage-extension/review/token' },
  }] }
  const catalog = await inventoryExtensions({ configurationRoot: root, configuration })
  const input: ExtensionSkillExecutionInput = {
    runId: 'run', configuration: { prefix: 'Result' },
    context: {
      prompt: '', invocation: { id: 'invocation', text: '/review', documentOrder: 1 },
      roots: [{ id: 'candidate', text: 'Candidate', documentOrder: 0 }],
      provenance: { ancestorPathIds: [], explicitLinkedRootIds: [] },
    },
    plan: { selectedNodeIds: ['candidate'], requestedReferenceIds: ['candidate'], admittedReferenceIds: ['candidate'], annotations: [], data: {} },
  }
  return { configuration, catalog, input }
}

it('accepts semantically identical executor metadata irrespective of property order', async () => {
  const value = await fixture(true)
  expect((await validateForageExtensionEntry(value.catalog.entries[0]!, value.configuration.sources[0]!)).diagnostics).toEqual([])
})

it.each([['ordinary', 'synthetic-secret'], ['JSON-escaped', 'synthetic-"secret\\with-newline\n']] as const)(
  'redacts %s secrets from every decoded observable field', async (_label, token) => {
    const value = await fixture()
    const loaded = await loadForageExtension(value.catalog.entries[0]!, { configuration: value.configuration.sources[0]! })
    const logs: Array<{ message: string; data?: unknown }> = []
    const progress: Array<{ message: string }> = []
    const result = await loaded.executeExecutor('summarize', value.input, {
      signal: new AbortController().signal, secrets: { token }, onLog: (event) => logs.push(event), onProgress: (event) => progress.push(event),
    })
    expect(logs[0]).toMatchObject({ message: '[REDACTED]', data: { token: '[REDACTED]', nested: [{ '[REDACTED]': 'prefix [REDACTED] suffix' }], numeric: 42 } })
    expect(progress[0]?.message).toBe('[REDACTED]')
    expect(JSON.stringify({ logs, progress })).not.toContain(token)
    expect(result.nodes[0]).toMatchObject({ segments: [{ nodeId: 'candidate', label: 'Candidate' }] })
  },
)

it.each([['ordinary', 'throw-synthetic-secret'], ['JSON-escaped', 'throw-synthetic-"secret\\with-newline\n']] as const)(
  'redacts %s secrets from executor errors', async (_label, token) => {
    const value = await fixture()
    const loaded = await loadForageExtension(value.catalog.entries[0]!, { configuration: value.configuration.sources[0]! })
    await expect(loaded.executeExecutor('summarize', value.input, {
      signal: new AbortController().signal, secrets: { token },
    })).rejects.toMatchObject({ code: 'executor_execution_failed', message: 'failed with [REDACTED]' })
  },
)
