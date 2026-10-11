import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiDispatcherClassifier } from './piDispatcher'

const fixture = vi.hoisted(() => ({ completeSimple: vi.fn(), create: vi.fn() }))
vi.mock('./piExecutor', () => ({ createServerPiModel: fixture.create }))

beforeEach(() => {
  vi.clearAllMocks()
  fixture.create.mockResolvedValue({ modelRuntime: { completeSimple: fixture.completeSimple }, model: { provider: 'anthropic', id: 'claude' } })
})

describe('Pi dispatcher provider authority', () => {
  it('sanitizes thrown provider failures', async () => {
    fixture.completeSimple.mockRejectedValue(new Error('only-admitted-key'))
    const failure = await new PiDispatcherClassifier({ provider: 'anthropic', apiKey: 'only-admitted-key' }, 'claude').classify({ text: 'Capture', source: {}, allowedSkillIds: ['research'] }, new AbortController().signal).catch((error: Error) => error)
    expect(String(failure)).not.toContain('only-admitted-key')
    expect(String(failure)).toContain('Dispatcher provider is unavailable')
  })
  it('uses only the admitted provider and allowed skill IDs without registering tools', async () => {
    fixture.completeSimple.mockResolvedValue({ stopReason: 'stop', content: [{ type: 'text', text: '{"skillIds":["research"]}' }] })
    const credential = { provider: 'anthropic' as const, apiKey: 'only-admitted-key' }
    const signal = new AbortController().signal
    await expect(new PiDispatcherClassifier(credential, 'claude').classify({ text: 'Untrusted instructions', source: {}, allowedSkillIds: ['research'] }, signal)).resolves.toEqual(['research'])
    expect(fixture.create).toHaveBeenCalledWith(credential, 'claude')
    expect(fixture.completeSimple.mock.calls[0]?.[1]).not.toHaveProperty('tools')
    expect(JSON.stringify(fixture.completeSimple.mock.calls)).not.toContain('only-admitted-key')
  })

  it.each(['not-json', '{"skillIds":["unconfigured"]}'])('rejects malformed or unconfigured decisions', async (text) => {
    fixture.completeSimple.mockResolvedValue({ stopReason: 'stop', content: [{ type: 'text', text }] })
    await expect(new PiDispatcherClassifier({ provider: 'opencode-go', apiKey: 'key' }, 'model').classify({ text: 'Capture', source: {}, allowedSkillIds: ['research'] }, new AbortController().signal)).rejects.toThrow('malformed output')
  })
})
