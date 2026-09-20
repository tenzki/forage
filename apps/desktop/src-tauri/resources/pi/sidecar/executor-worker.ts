#!/usr/bin/env node
import { runExtensionExecutorWorkerRequest } from '@forage/extension-host'

const MAX_INPUT = 1_000_000
const controller = new AbortController()
let buffer = ''

process.on('SIGTERM', () => controller.abort(new Error('Executor worker cancelled.')))
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  if (buffer.length > MAX_INPUT) fail('Executor worker input exceeded the allowed size.')
})
process.stdin.on('end', () => void main())

async function main(): Promise<void> {
  let value: unknown
  try {
    value = JSON.parse(buffer)
  } catch {
    fail('Executor worker input was not valid JSON.')
  }
  await runExtensionExecutorWorkerRequest(value, controller.signal, (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`)
  })
}

function fail(reason: string): never {
  process.stderr.write(`${reason}\n`)
  process.exit(1)
}
