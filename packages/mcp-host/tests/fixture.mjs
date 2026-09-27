import { appendFileSync, writeFileSync } from 'node:fs'

export function respond(request) {
  if (request.method === 'initialize') return { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
  if (request.method === 'tools/list') return { tools: [{
    name: 'echo.with-punctuation', description: process.env.DESCRIPTION ?? 'Echo a message',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
  }, { name: 'failure', description: 'Report a failure', inputSchema: { type: 'object', properties: {} } },
  { name: 'wait', description: 'Wait for cancellation', inputSchema: { type: 'object', properties: {} } }] }
  if (request.method === 'tools/call') {
    if (process.env.CALL_LOG) appendFileSync(process.env.CALL_LOG, `${request.params.name}\n`)
    if (request.params.name === 'wait') return new Promise(() => {})
    if (request.params.name === 'failure') return { isError: true, content: [{ type: 'text', text: 'Fixture rejected the operation' }] }
    return { content: [{ type: 'text', text: request.params.arguments.message }], structuredContent: { echo: request.params.arguments.message } }
  }
  return undefined
}

if (process.env.MCP_FIXTURE_STDIO === '1') {
  if (process.env.PID_FILE) writeFileSync(process.env.PID_FILE, String(process.pid))
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('end', () => setTimeout(() => process.exit(0), Number(process.env.CLOSE_DELAY ?? 0)))
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const request = JSON.parse(line)
      if (request.id === undefined) continue
      void Promise.resolve(respond(request)).then((result) => {
        const response = result === undefined ? { error: { code: -32601, message: 'Method not found' } } : { result }
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response })}\n`)
      })
    }
  })
}
