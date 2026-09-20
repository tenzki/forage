#!/usr/bin/env node
import { extensionCatalogEntrySchema, extensionSourceConfigurationSchema } from '@forage/agent-runtime'
import { validateForageExtensionEntry } from '@forage/extension-host'

const MAX_INPUT = 1_000_000
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  if (buffer.length > MAX_INPUT) fail('Validation input exceeded the allowed size.')
})
process.stdin.on('end', () => void main())

async function main(): Promise<void> {
  try {
    const value = JSON.parse(buffer) as { entry?: unknown; configuration?: unknown }
    const entry = extensionCatalogEntrySchema.parse(value.entry)
    const configuration = extensionSourceConfigurationSchema.parse(value.configuration)
    const result = await validateForageExtensionEntry(entry, configuration, {
      stderr: (line) => process.stderr.write(`[forage-extension] ${line}\n`),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      tools: [], executors: [], hooks: [], diagnostics: [{
        code: 'entry_validation_failed', severity: 'error', message: message(error).slice(0, 2_000),
      }],
    })}\n`)
  }
}

function fail(reason: string): never {
  process.stderr.write(`${reason}\n`)
  process.exit(1)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
