import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetch } from '@tauri-apps/plugin-http'
import {
  parseDuckDuckGoResults,
  resolveTools,
  validateCustomToolDraft,
  validatePublicWebUrl,
  WEB_FETCH_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
  type CustomHttpToolConfig,
} from './tools'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

const mockedFetch = vi.mocked(fetch)
const resultHtml = `
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle&amp;rut=x">
      Example result
    </a>
    <a class="result__snippet">A useful &amp; current result.</a>
  </div>
`

afterEach(() => vi.clearAllMocks())

describe('web search tool', () => {
  it('extracts titles, destination URLs, and snippets from DuckDuckGo', () => {
    expect(parseDuckDuckGoResults(resultHtml, 5)).toEqual([{
      title: 'Example result',
      url: 'https://example.com/article',
      snippet: 'A useful & current result.',
    }])
  })

  it('executes searches through Tauri HTTP and bounds the result count', async () => {
    mockedFetch.mockResolvedValue(new Response(resultHtml, { status: 200 }))
    const tool = resolveTools([WEB_SEARCH_TOOL_ID])[0]

    const output = await tool.execute({ query: 'workflowy alternatives', count: 99 })

    expect(mockedFetch).toHaveBeenCalledWith(
      'https://html.duckduckgo.com/html/?q=workflowy%20alternatives',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(output).toContain('1. Example result')
    expect(output).toContain('https://example.com/article')
  })

  it('reads public webpages through the allowlisted reader service', async () => {
    mockedFetch.mockResolvedValue(new Response('# Example\n\nReadable content.', { status: 200 }))
    const tool = resolveTools([WEB_FETCH_TOOL_ID])[0]

    const output = await tool.execute({ url: 'https://example.com/article' })

    expect(tool.activity({ url: 'https://lambdaworks.io/research' })).toBe('fetching: lambdaworks.io')
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://r.jina.ai/https://example.com/article',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(output).toContain('Readable content')
  })

  it('rejects local and credential-bearing webpage URLs', () => {
    expect(() => validatePublicWebUrl('http://127.0.0.1/admin')).toThrow('Private')
    expect(() => validatePublicWebUrl('https://user:pass@example.com')).toThrow('credentials')
  })

  it('builds executable custom tools only for approved origins', async () => {
    const draft = validateCustomToolDraft({
      name: 'github_issues',
      description: 'List public issues for a GitHub repository',
      urlTemplate: 'https://api.github.com/repos/{{owner}}/{{repo}}/issues',
    })
    const config: CustomHttpToolConfig = { ...draft, id: 'custom-1' }
    mockedFetch.mockResolvedValue(new Response('[{"title":"Issue"}]', { status: 200 }))
    const tool = resolveTools(['custom-1'], [config])[0]

    const output = await tool.execute({ owner: 'pi user', repo: 'agent' })

    expect(tool.definition.name).toBe('github_issues')
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/pi%20user/agent/issues',
      expect.any(Object),
    )
    expect(output).toContain('Issue')
    expect(() => validateCustomToolDraft({
      ...draft,
      urlTemplate: 'https://unapproved.example.com/{{query}}',
    })).toThrow('approved')
  })

  it('does not expose disabled or unknown tools', () => {
    expect(resolveTools([])).toEqual([])
    expect(resolveTools(['unknown'])).toEqual([])
  })
})
