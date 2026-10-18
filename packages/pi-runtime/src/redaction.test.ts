import { describe, expect, it } from 'vitest'
import { redactValue, redactedModels } from './redaction'
import { scriptedModel, fauxAssistantMessage } from './scripted-model.test-support'

it('redacts known secrets, credential patterns and incomplete credential suffixes before checkpointing', () => {
  const secret = 'opaque-provider-credential'
  expect(redactValue({ content: ['key ' + secret, 'Bearer opaque-token', 'api_key=opaque-token'] }, [secret]))
    .toEqual({ content: ['key [redacted]', '[redacted]', 'api_key=[redacted]'] })
  expect(redactValue('text opaque-provider-creden', [secret], true)).toBe('text [redacted]')
  expect(redactValue('ordinary text', [secret], true)).toBe('ordinary text')
})

describe('fenced model streams', () => {
  it('never calls a provider after execution ownership is lost', async () => {
    const model = await scriptedModel([fauxAssistantMessage('Must not execute.')])
    const models = redactedModels(model.modelRuntime, () => [], async () => { throw new Error('lease_lost') })
    const result = await models.streamSimple(model.model, { messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] }).result()
    expect(result.stopReason).toBe('error')
    expect(model.faux.state.callCount).toBe(0)
  })
})
