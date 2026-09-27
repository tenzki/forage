import { describe, expect, it } from 'vitest'
import type { RuntimeTool } from '@forage/agent-runtime'
import { adaptRuntimeTool } from './runtime-tools'
import { VerifiedSources } from './sources'

function tool(execute: RuntimeTool['execute']): RuntimeTool {
  return { id: 'web_read', name: 'Web read', description: 'Reads a public page.', execute }
}

async function run(runtimeTool: RuntimeTool, sources = new VerifiedSources(), args: Record<string, unknown> = {}) {
  const result = await adaptRuntimeTool(runtimeTool, sources).execute('call-1', args, undefined, undefined, {} as never)
  const content = result.content[0]
  return content.type === 'text' ? content.text : ''
}

describe('RuntimeTool adapter', () => {
  it('exposes the tool under its runtime ID and passes the model arguments through', async () => {
    let received: Record<string, unknown> = {}
    const adapted = adaptRuntimeTool(tool(async (args) => { received = args; return 'ok' }), new VerifiedSources())
    expect(adapted.name).toBe('web_read')
    expect(adapted.label).toBe('Web read')
    expect(await run(tool(async (args) => { received = args; return 'ok' }), undefined, { url: 'https://example.com' })).toBe('ok')
    expect(received).toEqual({ url: 'https://example.com' })
  })

  it('bounds tool output before it reaches the model', async () => {
    const text = await run(tool(async () => 'x'.repeat(40_000)))
    expect(text).toHaveLength(30_000 + '\n[tool output truncated]'.length)
    expect(text.endsWith('[tool output truncated]')).toBe(true)
    expect(await run(tool(async () => ({ items: [1, 2] })))).toBe('{"items":[1,2]}')
  })

  it('registers the canonical URL of untrusted source material as verified', async () => {
    const sources = new VerifiedSources()
    await run(tool(async () => ({
      trust: 'untrusted', sourceType: 'webpage', canonicalUrl: 'https://example.com/read', content: 'Body',
    })), sources)
    await run(tool(async () => 'Search result: https://example.com/lead'), sources)

    expect(sources.has('https://example.com/read#section')).toBe(true)
    expect(sources.has('https://example.com/lead')).toBe(false)
  })

  it('redacts credentials from tool errors', async () => {
    await expect(run(tool(async () => { throw new Error('Request failed with Bearer abc123 and api_key=sk-secret') })))
      .rejects.toThrow('Request failed with [redacted] and api_key=[redacted]')
  })

  it('keeps cancellation distinguishable from tool failure', async () => {
    await expect(run(tool(async () => { throw new DOMException('Aborted', 'AbortError') })))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})
