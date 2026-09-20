import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { extensionManagementResponseSchema, type ExtensionManagementResponse } from '@forage/agent-runtime'

const sidecarRoot = path.dirname(fileURLToPath(import.meta.url))
const referenceRoot = path.resolve(sidecarRoot, '../../../../../../extensions/reference')
const temporaryDirectories: string[] = []
const processes: ChildProcessWithoutNullStreams[] = []

afterEach(async () => {
  for (const child of processes.splice(0)) child.kill('SIGTERM')
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function copyReference(destination: string): Promise<void> {
  await mkdir(path.join(destination, 'dist'), { recursive: true })
  await copyFile(path.join(referenceRoot, 'forage.extension.json'), path.join(destination, 'forage.extension.json'))
  await copyFile(path.join(referenceRoot, 'dist/index.js'), path.join(destination, 'dist/index.js'))
  await symlink(path.join(referenceRoot, 'node_modules'), path.join(destination, 'node_modules'), 'dir')
}

function startManagement(configurationRoot: string, entry = path.join(sidecarRoot, 'management.ts')) {
  // --import avoids tsx CLI's optional IPC socket, which is unavailable in
  // filesystem-sandboxed test runners while exercising the same TypeScript entry.
  const args = entry.endsWith('.mjs') ? [entry] : ['--import', 'tsx', entry]
  const child = spawn(process.execPath, args, {
    cwd: sidecarRoot,
    env: { ...process.env, FORAGE_CONFIGURATION_ROOT: configurationRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  processes.push(child)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let buffer = ''
  let stderr = ''
  const waiting: Array<(value: Record<string, unknown>) => void> = []
  const queued: Record<string, unknown>[] = []
  child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000) })
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as Record<string, unknown>
      const waiter = waiting.shift()
      if (waiter) waiter(message)
      else queued.push(message)
    }
  })
  const next = () => new Promise<Record<string, unknown>>((resolve, reject) => {
    const queuedMessage = queued.shift()
    if (queuedMessage) return resolve(queuedMessage)
    const timer = setTimeout(() => reject(new Error(`Management response timed out. ${stderr}`)), 15_000)
    waiting.push((message) => { clearTimeout(timer); resolve(message) })
  })
  let sequence = 0
  return {
    child,
    next,
    async request(operation: string, fields: Record<string, unknown> = {}): Promise<ExtensionManagementResponse> {
      const requestId = `process-${++sequence}`
      child.stdin.write(`${JSON.stringify({ version: 1, kind: 'request', requestId, operation, ...fields })}\n`)
      const response = extensionManagementResponseSchema.parse(await next())
      expect(response.requestId).toBe(requestId)
      return response
    },
  }
}

describe('real extension management sidecar process', () => {
  it('boots the self-contained packaged run and management entries without node_modules', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forage-packaged-sidecar-'))
    temporaryDirectories.push(root)
    const management = startManagement(path.join(root, '.forage'), path.join(sidecarRoot, 'dist/management.mjs'))
    await expect(management.next()).resolves.toEqual({ version: 1, kind: 'ready' })
    await expect(management.request('inventory')).resolves.toMatchObject({
      ok: true, catalog: { entries: [] }, configuration: { sources: [] },
    })

    const run = spawn(process.execPath, [path.join(sidecarRoot, 'dist/index.mjs')], {
      cwd: sidecarRoot,
      env: { ...process.env, AI_CHAT_PROVIDER: 'openai', AI_CHAT_API_KEY: 'packaged-smoke-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    processes.push(run)
    run.stdout.setEncoding('utf8')
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged run sidecar did not become ready.')), 15_000)
      run.stdout.once('data', (chunk: string) => { clearTimeout(timer); resolve(chunk) })
      run.once('error', reject)
    })
    run.stdin.end()
    await expect(ready).resolves.toContain('{"type":"ready"}')
  }, 30_000)

  it('discovers a drop-in and completes the local preview, enable, configure, edit/reload, and removal loop', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forage-management-e2e-'))
    temporaryDirectories.push(root)
    const configurationRoot = path.join(root, '.forage')
    const dropIn = path.join(configurationRoot, 'extensions', 'reference-drop-in')
    const localSource = path.join(root, 'local-reference')
    await copyReference(dropIn)
    await copyReference(localSource)

    const management = startManagement(configurationRoot)
    await expect(management.next()).resolves.toEqual({ version: 1, kind: 'ready' })

    const initial = await management.request('inventory')
    expect(initial).toMatchObject({ ok: true, catalog: { entries: [expect.objectContaining({ status: 'needs_review' })] } })

    const preview = await management.request('preview_install', { source: { kind: 'local', path: localSource } })
    expect(preview).toMatchObject({
      ok: true,
      preview: { entry: { status: 'needs_review', manifest: { id: 'dev.forage.text-stats' } } },
    })
    if (!preview.ok || !preview.preview) throw new Error('Expected a local extension preview.')
    const previewId = preview.preview.previewId
    const installed = await management.request('install', {
      source: { kind: 'local', path: localSource }, previewId,
    })
    expect(installed).toMatchObject({ ok: true, entry: { status: 'needs_review' } })
    if (!installed.ok || !installed.entry) throw new Error('Expected an installed local extension.')
    const installationId = installed.entry.source.installationId

    const enabled = await management.request('enable', { installationId, trustAccepted: true })
    if (!enabled.ok) throw new Error(JSON.stringify(enabled.diagnostics))
    expect(enabled).toMatchObject({ ok: true, entry: { status: 'ready' } })
    expect(await management.request('configure', {
      installationId, settings: { progress_message: 'Sidecar process counting' }, secretReferences: {},
    })).toMatchObject({ ok: true, entry: { status: 'ready' } })

    const entryPath = path.join(localSource, 'dist/index.js')
    await writeFile(entryPath, `${await readFile(entryPath, 'utf8')}\n// local edit exercised by management-process test\n`)
    expect(await management.request('reload', { installationId }))
      .toMatchObject({ ok: true, entry: { status: 'ready' } })

    expect(await management.request('remove', { installationId }))
      .toMatchObject({ ok: true, removedInstallationId: installationId })
    expect((await stat(localSource)).isDirectory()).toBe(true)
  }, 30_000)
})
