import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extensionDiagnosticSchema,
  type ExtensionCatalogEntry,
  type ExtensionDiagnostic,
  type ExtensionSourceConfiguration,
} from '@forage/agent-runtime'

const MAX_OUTPUT = 256_000
const TERMINATION_GRACE_MS = 250

export function credentialFreeValidationEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR']
  return Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]))
}

export async function validateEntryInProcess(
  entry: ExtensionCatalogEntry,
  configuration: ExtensionSourceConfiguration,
  signal: AbortSignal,
): Promise<ExtensionDiagnostic[]> {
  const directory = path.dirname(fileURLToPath(import.meta.url))
  const bundled = path.extname(fileURLToPath(import.meta.url)) === '.mjs'
  const worker = path.join(directory, bundled ? 'validation-worker.mjs' : 'validation-worker.ts')
  const child = spawn(process.execPath, bundled ? [worker] : ['--import', 'tsx', worker], {
    cwd: directory,
    env: credentialFreeValidationEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let settled = false
  const terminate = () => {
    if (settled) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => { if (!settled) child.kill('SIGKILL') }, TERMINATION_GRACE_MS)
    timer.unref()
  }
  signal.addEventListener('abort', terminate, { once: true })
  if (signal.aborted) terminate()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    if (stdout.length > MAX_OUTPUT) terminate()
  })
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
  })
  child.stdin.end(JSON.stringify({ entry, configuration }))
  try {
    const result = await new Promise<{ code: number | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve({ code }))
    })
    settled = true
    if (signal.aborted) return [{ code: 'validation_cancelled', severity: 'error', message: 'Extension validation was cancelled.' }]
    if (result.code !== 0 || stdout.length > MAX_OUTPUT) {
      return [{ code: 'entry_validation_failed', severity: 'error', message: (stderr.trim() || 'Extension validation process failed.').slice(0, 2_000) }]
    }
    const parsed = JSON.parse(stdout) as { diagnostics?: unknown }
    return extensionDiagnosticSchema.array().max(100).parse(parsed.diagnostics)
  } catch (error) {
    return [{ code: 'entry_validation_failed', severity: 'error', message: message(error).slice(0, 2_000) }]
  } finally {
    settled = true
    signal.removeEventListener('abort', terminate)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
