#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import {
  ExtensionExecutorHost,
  forageConfigurationRoot,
  type AdmittedExtensionExecutorRun,
} from '@forage/extension-host'
import { createSidecarExtensionExecutorProcess } from './executor-process'

const MAX_LINE = 2_000_000
for (const name of [
  'AI_CHAT_PROVIDER', 'AI_CHAT_API_KEY', 'AI_CHAT_ACCOUNT_ID', 'AI_CHAT_MODEL_ID', 'AI_CHAT_OAUTH_EXPIRES',
  'OPENAI_API_KEY', 'OPENAI_ACCESS_TOKEN', 'ANTHROPIC_API_KEY',
]) delete process.env[name]

const host = new ExtensionExecutorHost(createSidecarExtensionExecutorProcess())
const admissions = new Map<string, AdmittedExtensionExecutorRun>()
const controllers = new Map<string, AbortController>()
let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.resume()
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  if (buffer.length > MAX_LINE) {
    process.stderr.write('[forage-extension-executor] input exceeded the allowed size\n')
    buffer = ''
    return
  }
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    void route(line)
  }
})

async function route(line: string): Promise<void> {
  let request: Record<string, unknown>
  try {
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.')
    request = value as Record<string, unknown>
  } catch {
    process.stderr.write('[forage-extension-executor] invalid JSON request\n')
    return
  }
  const requestId = typeof request.requestId === 'string' ? request.requestId : ''
  const operation = request.operation
  if (!requestId || typeof operation !== 'string') return
  if (operation === 'cancel') {
    const targetRequestId = typeof request.targetRequestId === 'string' ? request.targetRequestId : ''
    controllers.get(targetRequestId)?.abort()
    respond(requestId, operation, true, {})
    return
  }
  const controller = new AbortController()
  controllers.set(requestId, controller)
  const observable = {
    signal: controller.signal,
    onProgress: (progress: unknown) => event(requestId, 'progress', progress),
    onLog: (entry: unknown) => event(requestId, 'log', entry),
  }
  try {
    if (operation === 'admit') {
      const raw = request.input
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid executor admission input.')
      const admission = await host.admit({
        ...(raw as Parameters<ExtensionExecutorHost['admit']>[0]),
        configurationRoot: process.env.FORAGE_CONFIGURATION_ROOT ?? forageConfigurationRoot(),
      }, observable)
      const admissionId = randomUUID()
      admissions.set(admissionId, admission)
      respond(requestId, operation, true, {
        admissionId,
        executorSnapshot: admission.executorSnapshot,
        portableConfigurationRevision: admission.portableConfigurationRevision,
        configuration: admission.configuration,
        context: admission.context,
        plan: admission.plan,
      })
      return
    }
    const admissionId = typeof request.admissionId === 'string' ? request.admissionId : ''
    const admission = admissions.get(admissionId)
    if (!admission) throw new Error('The prepared extension admission is no longer available.')
    if (operation === 'release') {
      admissions.delete(admissionId)
      await admission.release()
      respond(requestId, operation, true, {})
      return
    }
    if (operation === 'execute') {
      const secrets = request.secrets && typeof request.secrets === 'object' && !Array.isArray(request.secrets)
        ? request.secrets as Record<string, string | undefined>
        : {}
      const result = await admission.execute({ ...observable, secrets })
      admissions.delete(admissionId)
      await admission.release()
      respond(requestId, operation, true, { result })
      return
    }
    throw new Error('Unsupported extension executor operation.')
  } catch (error) {
    respond(requestId, operation, false, {
      code: typeof error === 'object' && error && 'code' in error ? String(error.code) : 'extension_executor_failed',
      message: error instanceof Error ? error.message : String(error),
      ...(typeof error === 'object' && error && 'issues' in error ? { issues: error.issues } : {}),
    })
  } finally {
    controllers.delete(requestId)
  }
}

function event(requestId: string, type: 'progress' | 'log', value: unknown): void {
  process.stdout.write(`${JSON.stringify({ version: 1, kind: 'event', requestId, type, value })}\n`)
}

function respond(requestId: string, operation: string, ok: boolean, value: object): void {
  process.stdout.write(`${JSON.stringify({ version: 1, kind: 'response', requestId, operation, ok, ...value })}\n`)
}

async function shutdown(): Promise<void> {
  controllers.forEach((controller) => controller.abort())
  await Promise.all([...admissions.values()].map((admission) => admission.release().catch(() => undefined)))
  process.exit(0)
}

process.once('SIGTERM', () => { void shutdown() })
process.once('SIGINT', () => { void shutdown() })
process.stdout.write(`${JSON.stringify({ version: 1, kind: 'ready' })}\n`)
