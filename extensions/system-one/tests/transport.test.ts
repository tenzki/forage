import { describe, expect, it, vi } from 'vitest'
import {
  buildTypeSafeRequest,
  evaluateWithTypeSafe,
  PROBABILITY_SUM_TOLERANCE,
  TypeSafeTransportError,
  validateTypeSafeResponse,
  type SystemOneConfiguration,
} from '../src/index.js'
import { preparedData, scoreConfiguration } from './fixtures.js'

function response(answers: Record<string, unknown>, model = 'jev-1.13.0') {
  return { model, answers, usage: { input_tokens: 123, output_tokens: 7 } }
}

describe('TypeSafe Jev transport', () => {
  it('keeps a comparative Choice set complete in one question', () => {
    const configuration: SystemOneConfiguration = {
      ...scoreConfiguration(), kind: 'choice-comparison', ordering: 'descending',
    }
    const request = buildTypeSafeRequest(configuration, preparedData, '')
    expect(Object.keys(request.questions)).toEqual(['comparison'])
    expect(request.questions.comparison).toMatchObject({
      type: 'choice', criteria: { option_0: { candidate_id: 'idea-a' }, option_1: { candidate_id: 'idea-b' } },
    })
    expect(request.state.candidates).toHaveLength(2)
  })

  it.each([
    ['classification', {
      ...scoreConfiguration(), kind: 'choice-classification',
      categories: [
        { id: 'build', label: 'Build', description: 'Build now.' },
        { id: 'defer', label: 'Defer', description: 'Defer it.' },
      ],
    } as SystemOneConfiguration, 'choice'],
    ['score', scoreConfiguration(), 'score'],
    ['noul', {
      ...scoreConfiguration(), kind: 'noul', threshold: 0.8,
      yesDefinition: 'Actionable', noDefinition: 'Not actionable',
    } as SystemOneConfiguration, 'noul'],
  ])('batches every candidate-specific %s question in one request', (_label, configuration, type) => {
    const request = buildTypeSafeRequest(configuration, preparedData, 'Use current constraints.')
    expect(Object.keys(request.questions)).toEqual(['candidate_0', 'candidate_1'])
    expect(Object.values(request.questions).every((question) => question.type === type)).toBe(true)
    expect(request.questions.candidate_0?.instructions).toMatchObject({
      question: configuration.question,
      candidate_id: 'idea-a',
    })
    expect(request.state.additional_user_guidance).toBe('Use current constraints.')
  })

  it('accepts complete typed answers and reports the concrete model behind an alias', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { questions: Record<string, { criteria: string[] }> }
      return new Response(JSON.stringify(response({
        candidate_0: { type: 'score', score: 1, legend: { 0: request.questions.candidate_0!.criteria[0], 1: request.questions.candidate_0!.criteria[1] }, probabilities: { 0: 0, 1: 1 }, confidence: 1 },
        candidate_1: { type: 'score', score: 0.25, legend: { 0: request.questions.candidate_1!.criteria[0], 1: request.questions.candidate_1!.criteria[1] }, probabilities: { 0: 0.75, 1: 0.25 }, confidence: 0.5 },
      }, 'typesafe/jev-1.13-20260917')))
    })
    const progress: string[] = []
    const result = await evaluateWithTypeSafe({
      configuration: scoreConfiguration(), prepared: preparedData, prompt: '', apiKey: 'synthetic-key',
      signal: new AbortController().signal, fetch: fetch as typeof globalThis.fetch,
      reportProgress: ({ message }) => progress.push(message),
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer synthetic-key' })
    expect(result.actualModel).toBe('typesafe/jev-1.13-20260917')
    expect(progress[progress.length - 1]).toContain('typesafe/jev-1.13-20260917')
  })

  it.each([
    ['missing answer', (request: ReturnType<typeof buildTypeSafeRequest>) => response({ candidate_0: validScore(request, 0) })],
    ['extra answer', (request: ReturnType<typeof buildTypeSafeRequest>) => response({ candidate_0: validScore(request, 0), candidate_1: validScore(request, 1), extra: validScore(request, 0) })],
    ['wrong legend', (request: ReturnType<typeof buildTypeSafeRequest>) => response({ candidate_0: { ...validScore(request, 0), legend: { 0: 'changed', 1: 'wrong' } }, candidate_1: validScore(request, 1) })],
    ['invalid distribution', (request: ReturnType<typeof buildTypeSafeRequest>) => response({ candidate_0: { ...validScore(request, 0), probabilities: { 0: 0.7, 1: 0.2 }, score: 0.2 }, candidate_1: validScore(request, 1) })],
    ['inconsistent score', (request: ReturnType<typeof buildTypeSafeRequest>) => response({ candidate_0: { ...validScore(request, 0), score: 0.5 }, candidate_1: validScore(request, 1) })],
    ['unknown type', (request: ReturnType<typeof buildTypeSafeRequest>) => response({ candidate_0: { ...validScore(request, 0), type: 'noul' }, candidate_1: validScore(request, 1) })],
  ])('rejects a %s', (_label, makeResponse) => {
    const request = buildTypeSafeRequest(scoreConfiguration(), preparedData, '')
    expect(() => validateTypeSafeResponse(makeResponse(request), request)).toThrow(TypeSafeTransportError)
  })

  it('rejects Choice unknown IDs, invalid selected options, and Noul confidence', () => {
    const choiceConfiguration: SystemOneConfiguration = { ...scoreConfiguration(), kind: 'choice-comparison' }
    const choiceRequest = buildTypeSafeRequest(choiceConfiguration, preparedData, '')
    expect(() => validateTypeSafeResponse(response({ comparison: {
      type: 'choice', choice: 'outside', probabilities: { option_0: 0.5, option_1: 0.5 }, confidence: 0,
    } }), choiceRequest)).toThrow(/unknown Choice option/i)
    expect(() => validateTypeSafeResponse(response({ comparison: {
      type: 'choice', choice: 'option_0', probabilities: { option_0: 0.2, option_1: 0.8 }, confidence: 0.6,
    } }), choiceRequest)).toThrow(/does not match/i)
    expect(() => validateTypeSafeResponse(response({ comparison: {
      type: 'choice', choice: 'option_0', probabilities: { option_0: 0.7, option_1: 0.2 }, confidence: 0.6,
    } }), choiceRequest)).toThrow(/do not sum to one/i)

    const noulConfiguration: SystemOneConfiguration = { ...scoreConfiguration(), kind: 'noul', threshold: 0.5 }
    const noulRequest = buildTypeSafeRequest(noulConfiguration, preparedData, '')
    expect(() => validateTypeSafeResponse(response({
      candidate_0: { type: 'noul', noul: 0.9, confidence: 0.8 },
      candidate_1: { type: 'noul', noul: 0.1 },
    }), noulRequest)).toThrow(/invalid Noul/i)
    expect(() => validateTypeSafeResponse(response({
      candidate_0: { type: 'noul', noul: Number.POSITIVE_INFINITY },
      candidate_1: { type: 'noul', noul: 0.1 },
    }), noulRequest)).toThrow(/finite number/i)
  })

  it('fails before fetch without a scoped secret and never retries controlled HTTP failures', async () => {
    const fetch = vi.fn(async () => new Response('synthetic-sensitive-body', { status: 429 }))
    await expect(evaluateWithTypeSafe({
      configuration: scoreConfiguration(), prepared: preparedData, prompt: '', apiKey: undefined,
      signal: new AbortController().signal, fetch: fetch as typeof globalThis.fetch,
    })).rejects.toMatchObject({ code: 'typesafe_authentication_required' })
    expect(fetch).not.toHaveBeenCalled()

    await expect(evaluateWithTypeSafe({
      configuration: scoreConfiguration(), prepared: preparedData, prompt: '', apiKey: 'synthetic-key',
      signal: new AbortController().signal, fetch: fetch as typeof globalThis.fetch,
    })).rejects.toMatchObject({ code: 'typesafe_rate_limited' })
    expect(fetch).toHaveBeenCalledOnce()
    try {
      await evaluateWithTypeSafe({
        configuration: scoreConfiguration(), prepared: preparedData, prompt: '', apiKey: 'synthetic-key',
        signal: new AbortController().signal,
        fetch: vi.fn(async () => new Response('synthetic-sensitive-body', { status: 401 })) as typeof globalThis.fetch,
      })
    } catch (error) {
      expect(String(error)).not.toContain('synthetic-sensitive-body')
      expect(String(error)).not.toContain('synthetic-key')
    }
  })

  it.each([
    [401, 'typesafe_authentication_failed'],
    [402, 'typesafe_quota_exhausted'],
    [408, 'typesafe_timeout'],
    [422, 'typesafe_request_rejected'],
    [429, 'typesafe_rate_limited'],
    [529, 'typesafe_unavailable'],
  ])('classifies HTTP %i without exposing the response body or retrying', async (status, code) => {
    const fetch = vi.fn(async () => new Response('synthetic-secret-response', { status }))
    const execution = evaluateWithTypeSafe({
      configuration: scoreConfiguration(), prepared: preparedData, prompt: '', apiKey: 'synthetic-key',
      signal: new AbortController().signal, fetch: fetch as typeof globalThis.fetch,
    })
    await expect(execution).rejects.toMatchObject({ code })
    await execution.catch((error: unknown) => {
      expect(String(error)).not.toContain('synthetic-secret-response')
      expect(String(error)).not.toContain('synthetic-key')
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('classifies network, malformed, and oversized responses without retrying', async () => {
    const networkFetch = vi.fn(async () => { throw new Error('socket exposed synthetic-key') })
    await expect(evaluateWithTypeSafe({
      configuration: scoreConfiguration(), prepared: preparedData, prompt: '', apiKey: 'synthetic-key',
      signal: new AbortController().signal, fetch: networkFetch as typeof globalThis.fetch,
    })).rejects.toMatchObject({ code: 'typesafe_network_error' })
    expect(networkFetch).toHaveBeenCalledOnce()

    const malformedFetch = vi.fn(async () => new Response('{not-json'))
    await expect(evaluateWithTypeSafe({
      configuration: scoreConfiguration(), prepared: preparedData, prompt: '', apiKey: 'synthetic-key',
      signal: new AbortController().signal, fetch: malformedFetch as typeof globalThis.fetch,
    })).rejects.toMatchObject({ code: 'typesafe_malformed_response' })

    const oversizedFetch = vi.fn(async () => new Response('ignored', { headers: { 'content-length': '1000001' } }))
    await expect(evaluateWithTypeSafe({
      configuration: scoreConfiguration(), prepared: preparedData, prompt: '', apiKey: 'synthetic-key',
      signal: new AbortController().signal, fetch: oversizedFetch as typeof globalThis.fetch,
    })).rejects.toMatchObject({ code: 'typesafe_response_too_large' })
  })

  it('propagates cancellation into the one in-flight request', async () => {
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const controller = new AbortController()
    const execution = evaluateWithTypeSafe({
      configuration: scoreConfiguration(), prepared: preparedData, prompt: '', apiKey: 'synthetic-key',
      signal: controller.signal, fetch: fetch as typeof globalThis.fetch,
    })
    controller.abort(new Error('cancelled'))
    await expect(execution).rejects.toThrow(/cancelled/i)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('documents a narrow distribution tolerance', () => {
    expect(PROBABILITY_SUM_TOLERANCE).toBe(0.001)
  })
})

function validScore(request: ReturnType<typeof buildTypeSafeRequest>, index: number) {
  const question = request.questions[`candidate_${index}`]
  if (!question || question.type !== 'score') throw new Error('expected score question')
  return {
    type: 'score', score: 0, legend: { 0: question.criteria[0], 1: question.criteria[1] },
    probabilities: { 0: 1, 1: 0 }, confidence: 1,
  }
}
