#!/usr/bin/env node
import { ExtensionManagementService } from '@forage/extension-host'
import { validateEntryInProcess } from './validation-process'

const MAX_LINE = 1_000_000
for (const name of [
  'AI_CHAT_PROVIDER', 'AI_CHAT_API_KEY', 'AI_CHAT_ACCOUNT_ID', 'AI_CHAT_MODEL_ID', 'AI_CHAT_OAUTH_EXPIRES',
  'OPENAI_API_KEY', 'OPENAI_ACCESS_TOKEN', 'ANTHROPIC_API_KEY',
]) delete process.env[name]
const service = new ExtensionManagementService({
  configurationRoot: process.env.FORAGE_CONFIGURATION_ROOT,
  validateEntry: validateEntryInProcess,
})

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.resume()
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  if (buffer.length > MAX_LINE) {
    process.stderr.write('[forage-extension-management] input exceeded the allowed size\n')
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
  try {
    const response = await service.handle(JSON.parse(line) as unknown)
    process.stdout.write(`${JSON.stringify(response)}\n`)
  } catch (error) {
    process.stderr.write(`[forage-extension-management] ${message(error).slice(0, 2_000)}\n`)
  }
}

process.stdout.write(`${JSON.stringify({ version: 1, kind: 'ready' })}\n`)

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
