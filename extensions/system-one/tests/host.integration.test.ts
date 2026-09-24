import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionConfiguration, ExtensionJsonObject } from '@forage/agent-runtime'
import {
  ExtensionExecutorHost,
  NodeExtensionExecutorProcess,
  credentialFreeExecutorEnvironment,
  inventoryExtensions,
} from '@forage/extension-host'
import { baseConfiguration, contextSnapshot } from './fixtures.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(testDirectory, '..')
const repositoryRoot = path.resolve(packageRoot, '../..')
const workerPath = path.join(repositoryRoot, 'apps/desktop/src-tauri/resources/pi/sidecar/executor-worker.ts')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'forage-system-one-'))
  roots.push(root)
  const source = path.join(root, 'extension')
  await mkdir(source)
  await Promise.all([
    cp(path.join(packageRoot, 'dist'), path.join(source, 'dist'), { recursive: true }),
    cp(path.join(packageRoot, 'forage.extension.json'), path.join(source, 'forage.extension.json')),
    cp(path.join(packageRoot, 'package.json'), path.join(source, 'package.json')),
  ])
  const apiScope = path.join(source, 'node_modules', '@forage')
  await mkdir(apiScope, { recursive: true })
  await symlink(path.join(repositoryRoot, 'packages/extension-api'), path.join(apiScope, 'extension-api'))
  const preload = path.join(root, 'mock-fetch.mjs')
  await writeFile(preload, `
if (process.env.OPENAI_API_KEY || process.env.CODEX_TOKEN || process.env.UNRELATED_SECRET) {
  throw new Error('inference credential leaked')
}
globalThis.fetch = async (_url, options) => {
  if (options.headers.authorization === 'Bearer synthetic-hang') {
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  }
  const request = JSON.parse(options.body)
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria)
      return [id, { type: 'choice', choice: keys[0], probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])), confidence: 1 }]
    }
    if (question.type === 'score') {
      return [id, { type: 'score', score: 0, legend: Object.fromEntries(question.criteria.map((value, index) => [String(index), value])), probabilities: Object.fromEntries(question.criteria.map((_value, index) => [String(index), index === 0 ? 1 : 0])), confidence: 1 }]
    }
    return [id, { type: 'noul', noul: id === 'candidate_0' ? 0.9 : 0.7 }]
  }))
  return new Response(JSON.stringify({ model: 'typesafe/jev-1.13-20260917', answers, usage: { input_tokens: 50, output_tokens: 5 } }))
}
`)
  const sourceConfiguration = {
    installationId: 'system-one-test',
    source: { kind: 'local' as const, path: source },
    enabled: true,
    trust: { accepted: true as const, extensionId: 'app.forage.system-one' },
    settings: {},
    secretReferences: { typesafe_api_key: 'forage-extension/system-one-test/typesafe_api_key' },
  }
  const localConfiguration: ExtensionConfiguration = { version: 1, revision: 19, sources: [sourceConfiguration] }
  const catalog = await inventoryExtensions({ configurationRoot: root, configuration: localConfiguration })
  const runner = new NodeExtensionExecutorProcess({
    workerPath,
    nodeArguments: ['--import', 'tsx', '--import', preload],
    environment: credentialFreeExecutorEnvironment({
      ...process.env,
      OPENAI_API_KEY: 'must-not-leak',
      CODEX_TOKEN: 'must-not-leak',
      UNRELATED_SECRET: 'must-not-leak',
    }),
    executionDeadlineMs: 1_000,
    terminationGraceMs: 20,
  })
  return { root, source, localConfiguration, catalog, runner }
}

async function admit(configuration: ExtensionJsonObject) {
  const value = await fixture()
  const host = new ExtensionExecutorHost(value.runner)
  const admission = await host.admit({
    catalog: value.catalog,
    localConfiguration: value.localConfiguration,
    configurationRoot: value.root,
    portableConfigurationRevision: 7,
    executor: { extensionId: 'app.forage.system-one', executorId: 'evaluate' },
    runId: 'system-one-run',
    configuration,
    context: contextSnapshot,
    hostAdmittedReferenceIds: ['root', 'parent', 'idea-a', 'evidence-a', 'idea-b', 'empty', 'constraints', 'constraint-one'],
  }, { signal: new AbortController().signal })
  return { ...value, admission }
}

describe('System One through the generic executor host', () => {
  it.each([
    ['Choice comparison', { ...baseConfiguration, kind: 'choice-comparison' }],
    ['Choice classification', {
      ...baseConfiguration,
      kind: 'choice-classification',
      categories: [
        { id: 'build', label: 'Build', description: 'Build now.' },
        { id: 'defer', label: 'Defer', description: 'Defer it.' },
      ],
    }],
    ['Score', baseConfiguration],
    ['Noul', { ...baseConfiguration, kind: 'noul', threshold: 0.8 }],
  ])('executes %s with mocked HTTP and no LLM credentials', async (_label, configuration) => {
    const value = await admit(configuration)
    const logs: Array<{ message: string; data?: unknown }> = []
    const result = await value.admission.execute({
      signal: new AbortController().signal,
      secrets: { typesafe_api_key: 'synthetic-key', unrelated: 'must-not-arrive' },
      onLog: (entry) => logs.push(entry),
    })
    expect(result.nodes[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(result)).not.toContain('typesafe/jev-1.13-20260917')
    expect(JSON.stringify(result)).toContain('idea-a')
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({
      message: 'System One evaluation completed with typesafe/jev-1.13-20260917.',
      data: expect.objectContaining({ requestedModel: 'jev-latest', actualModel: 'typesafe/jev-1.13-20260917' }),
    })]))
    await value.admission.release()
  })

  it('carries an in-place reorder through the executor host and reports each answer in activity', async () => {
    const value = await admit({ ...baseConfiguration, output: 'reorder', ordering: 'descending' })
    const logs: Array<{ message: string }> = []
    const result = await value.admission.execute({
      signal: new AbortController().signal,
      secrets: { typesafe_api_key: 'synthetic-key' },
      onLog: (entry) => logs.push(entry),
    })
    expect(result.nodes).toEqual([])
    expect([...result.reorder?.nodeIds ?? []].sort()).toEqual(['idea-a', 'idea-b'])
    expect(logs.map((entry) => entry.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Offline capture - /),
      expect.stringMatching(/^Keyboard navigation - /),
    ]))
    await value.admission.release()
  })

  it('fails missing secrets before HTTP and propagates host cancellation', async () => {
    const missing = await admit(baseConfiguration)
    await expect(missing.admission.execute({ signal: new AbortController().signal }))
      .rejects.toThrow(/Configure the TypeSafe API key/i)
    await missing.admission.release()

    const cancelled = await admit(baseConfiguration)
    const controller = new AbortController()
    const execution = cancelled.admission.execute({
      signal: controller.signal,
      secrets: { typesafe_api_key: 'synthetic-hang' },
    })
    setTimeout(() => controller.abort(new Error('cancelled by test')), 30)
    await expect(execution).rejects.toMatchObject({ code: 'executor_cancelled' })
    await cancelled.admission.release()
  })

  it('rechecks the admitted extension source before a provider request', async () => {
    const value = await admit(baseConfiguration)
    const entry = path.join(value.source, 'dist', 'index.js')
    await writeFile(entry, `${await readFile(entry, 'utf8')}\n// changed after admission\n`)
    await expect(value.admission.execute({
      signal: new AbortController().signal,
      secrets: { typesafe_api_key: 'synthetic-key' },
    })).rejects.toMatchObject({ code: 'stale_extension_revision' })
    await value.admission.release()
  })

  it('is only inventoried when explicitly configured and is never activated by workspace installation', async () => {
    const value = await fixture()
    const untrusted: ExtensionConfiguration = {
      version: 1,
      revision: 1,
      sources: [{
        installationId: 'system-one-test', source: { kind: 'local', path: value.source }, enabled: false,
        trust: { accepted: false }, settings: {}, secretReferences: {},
      }],
    }
    const catalog = await inventoryExtensions({ configurationRoot: value.root, configuration: untrusted })
    expect(catalog.entries[0]).toMatchObject({
      status: 'needs_review',
      manifest: { id: 'app.forage.system-one', contributes: { tools: [], hooks: [] } },
    })
    expect(catalog.entries[0]?.executors?.[0]).toMatchObject({ id: 'evaluate', available: false })
  })
})
