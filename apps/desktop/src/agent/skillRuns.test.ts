import { describe, expect, it } from 'vitest'
import { parseSteeredPrompt, steeredPrompt } from './skillRuns'

describe('steered skill prompts', () => {
  it('round-trips the original request and the steering note', () => {
    const prompt = steeredPrompt('spaced repetition', 'One bullet per technique.', 2, ['- Leitner boxes', '  - Five boxes'])

    expect(prompt).toContain('Previous result:\n- Leitner boxes\n  - Five boxes')
    expect(parseSteeredPrompt(prompt)).toEqual({
      basePrompt: 'spaced repetition',
      note: 'One bullet per technique.',
      iteration: 2,
    })
  })

  it('leaves an ordinary prompt alone', () => {
    expect(parseSteeredPrompt('spaced repetition')).toEqual({ basePrompt: 'spaced repetition' })
  })
})
