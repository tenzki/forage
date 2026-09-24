import type { ExtensionProgress } from '@forage/extension-api'
import type { SystemOneConfiguration } from './domain.js'
import type { PreparedCandidate, PreparedSystemOneData } from './preparation.js'

export const TYPESAFE_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'
export const PROBABILITY_SUM_TOLERANCE = 0.001
/** TypeSafe reports probabilities and scores rounded to two decimal places. */
export const REPORTED_ROUNDING_ERROR = 0.005
export const TYPESAFE_REQUEST_TIMEOUT_MS = 60_000
const MAX_REQUEST_BYTES = 256_000
const MAX_RESPONSE_BYTES = 1_000_000
const MAX_QUESTIONS = 100

type JsonInstruction = string | ReadonlyArray<unknown> | Readonly<Record<string, unknown>>

interface ChoiceQuestion {
  type: 'choice'
  instructions: JsonInstruction
  criteria: Record<string, unknown>
}

interface ScoreQuestion {
  type: 'score'
  instructions: JsonInstruction
  criteria: string[]
}

interface NoulQuestion {
  type: 'noul'
  instructions: JsonInstruction
  criteria?: { true?: string; false?: string }
}

export type TypeSafeQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion

export interface TypeSafeRequest {
  model: string
  state: {
    candidates: ReadonlyArray<{
      id: string
      text: string
      evidence: ReadonlyArray<{ id: string; text: string }>
    }>
    shared_evidence: ReadonlyArray<{ id: string; text: string; provenance: string }>
    additional_user_guidance?: string
  }
  questions: Record<string, TypeSafeQuestion>
}

export interface ChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

export interface ScoreAnswer {
  type: 'score'
  score: number
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

export interface NoulAnswer {
  type: 'noul'
  noul: number
}

export type TypeSafeAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer

export interface SystemOneEvaluation {
  requestedModel: string
  actualModel: string
  answers: ReadonlyMap<string, TypeSafeAnswer>
  usage: { inputTokens: number; outputTokens: number }
}

export class TypeSafeTransportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'TypeSafeTransportError'
  }
}

export function buildTypeSafeRequest(
  configuration: SystemOneConfiguration,
  prepared: PreparedSystemOneData,
  prompt: string,
): TypeSafeRequest {
  const additionalPrompt = prompt.trim()
  const state = {
    candidates: prepared.candidates.map((candidate) => ({
      id: candidate.id,
      text: candidate.text,
      evidence: candidate.evidence.map((entry) => ({ id: entry.id, text: entry.text })),
    })),
    shared_evidence: prepared.sharedEvidence.map((entry) => ({
      id: entry.id,
      text: entry.text,
      provenance: entry.provenance,
    })),
    ...(additionalPrompt ? { additional_user_guidance: additionalPrompt } : {}),
  }
  const instructions = (candidate?: PreparedCandidate): Readonly<Record<string, unknown>> => ({
    question: configuration.question,
    ...(candidate ? {
      candidate_id: candidate.id,
      candidate_location: 'Find this exact candidate ID in `state.candidates`; evaluate that candidate with its evidence and shared evidence.',
    } : {}),
  })

  let questions: Record<string, TypeSafeQuestion>
  if (configuration.kind === 'choice-comparison') {
    questions = {
      comparison: {
        type: 'choice',
        instructions: instructions(),
        criteria: Object.fromEntries(prepared.candidates.map((candidate, index) => [
          optionKey(index),
          {
            candidate_id: candidate.id,
            text: candidate.text,
            evidence: candidate.evidence.map((entry) => entry.text),
          },
        ])),
      },
    }
  } else if (configuration.kind === 'choice-classification') {
    const criteria = Object.fromEntries(configuration.categories.map((category) => [category.id, category.description]))
    questions = Object.fromEntries(prepared.candidates.map((candidate, index) => [
      questionKey(index),
      { type: 'choice', instructions: instructions(candidate), criteria },
    ]))
  } else if (configuration.kind === 'score') {
    const criteria = configuration.levels.map((level) => `${level.label}: ${level.description}`)
    questions = Object.fromEntries(prepared.candidates.map((candidate, index) => [
      questionKey(index),
      { type: 'score', instructions: instructions(candidate), criteria },
    ]))
  } else {
    const criteria = configuration.yesDefinition || configuration.noDefinition
      ? {
        ...(configuration.yesDefinition ? { true: configuration.yesDefinition } : {}),
        ...(configuration.noDefinition ? { false: configuration.noDefinition } : {}),
      }
      : undefined
    questions = Object.fromEntries(prepared.candidates.map((candidate, index) => [
      questionKey(index),
      { type: 'noul', instructions: instructions(candidate), ...(criteria ? { criteria } : {}) },
    ]))
  }

  if (Object.keys(questions).length > MAX_QUESTIONS) {
    throw new TypeSafeTransportError('typesafe_request_too_large', `System One expanded to more than ${MAX_QUESTIONS} questions.`)
  }
  return { model: configuration.model, state, questions }
}

export async function evaluateWithTypeSafe(input: {
  configuration: SystemOneConfiguration
  prepared: PreparedSystemOneData
  prompt: string
  apiKey: string | undefined
  signal: AbortSignal
  fetch?: typeof fetch
  reportProgress?: (progress: ExtensionProgress) => void
}): Promise<SystemOneEvaluation> {
  input.signal.throwIfAborted()
  const apiKey = input.apiKey?.trim()
  if (!apiKey) {
    throw new TypeSafeTransportError(
      'typesafe_authentication_required',
      'Configure the TypeSafe API key for the System One extension before running this skill.',
    )
  }
  const request = buildTypeSafeRequest(input.configuration, input.prepared, input.prompt)
  const serialized = JSON.stringify(request)
  if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
    throw new TypeSafeTransportError(
      'typesafe_request_too_large',
      `System One request exceeds the ${MAX_REQUEST_BYTES.toLocaleString()}-byte limit; reduce candidate evidence or questions.`,
    )
  }

  input.reportProgress?.({ message: `Evaluating ${Object.keys(request.questions).length} System One question${Object.keys(request.questions).length === 1 ? '' : 's'}`, completed: 0, total: 1 })
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal.reason)
  input.signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new TypeSafeTransportError('typesafe_timeout', 'TypeSafe evaluation timed out.')),
    TYPESAFE_REQUEST_TIMEOUT_MS,
  )
  timeout.unref?.()
  try {
    const response = await (input.fetch ?? globalThis.fetch)(TYPESAFE_SYSTEM_ONE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: serialized,
      signal: controller.signal,
    })
    if (!response.ok) throw classifyHttpFailure(response.status)
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new TypeSafeTransportError('typesafe_response_too_large', 'TypeSafe returned an oversized response.')
    }
    const text = await readBoundedResponse(response)
    let value: unknown
    try {
      value = JSON.parse(text) as unknown
    } catch {
      throw new TypeSafeTransportError('typesafe_malformed_response', 'TypeSafe returned malformed JSON.')
    }
    const evaluation = validateTypeSafeResponse(value, request)
    input.reportProgress?.({ message: `System One evaluated with ${evaluation.actualModel}`, completed: 1, total: 1 })
    return evaluation
  } catch (error) {
    if (error instanceof TypeSafeTransportError) throw error
    if (input.signal.aborted) throw input.signal.reason ?? new DOMException('Cancelled', 'AbortError')
    if (controller.signal.aborted) {
      throw new TypeSafeTransportError('typesafe_timeout', 'TypeSafe evaluation timed out.')
    }
    throw new TypeSafeTransportError('typesafe_network_error', 'TypeSafe could not be reached. Check the network connection and try again.')
  } finally {
    clearTimeout(timeout)
    input.signal.removeEventListener('abort', abort)
  }
}

export function validateTypeSafeResponse(value: unknown, request: TypeSafeRequest): SystemOneEvaluation {
  if (!isObject(value) || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200
    || !isObject(value.answers) || !isObject(value.usage)) {
    throw malformed('TypeSafe response envelope is incomplete.')
  }
  const inputTokens = nonnegativeInteger(value.usage.input_tokens)
  const outputTokens = nonnegativeInteger(value.usage.output_tokens)
  if (inputTokens === undefined || outputTokens === undefined) throw malformed('TypeSafe usage is invalid.')
  assertExactKeys(value.answers, Object.keys(request.questions), 'answer IDs')
  const answers = new Map<string, TypeSafeAnswer>()
  for (const [id, question] of Object.entries(request.questions)) {
    const raw = value.answers[id]
    if (question.type === 'choice') answers.set(id, validateChoiceAnswer(raw, question))
    else if (question.type === 'score') answers.set(id, validateScoreAnswer(raw, question))
    else answers.set(id, validateNoulAnswer(raw))
  }
  return {
    requestedModel: request.model,
    actualModel: value.model,
    answers,
    usage: { inputTokens, outputTokens },
  }
}

function validateChoiceAnswer(value: unknown, question: ChoiceQuestion): ChoiceAnswer {
  if (!isObject(value) || !hasExactKeys(value, ['type', 'choice', 'probabilities', 'confidence'])
    || value.type !== 'choice' || typeof value.choice !== 'string' || !isObject(value.probabilities)) {
    throw malformed('TypeSafe returned an invalid Choice answer.')
  }
  const expected = Object.keys(question.criteria)
  assertExactKeys(value.probabilities, expected, 'Choice probability options')
  const probabilities = probabilityDistribution(value.probabilities, 'Choice')
  const confidence = probability(value.confidence, 'Choice confidence')
  if (!(value.choice in question.criteria)) throw malformed('TypeSafe selected an unknown Choice option.')
  const selectedProbability = probabilities[value.choice]!
  const maximum = Math.max(...Object.values(probabilities))
  if (selectedProbability + PROBABILITY_SUM_TOLERANCE < maximum) {
    throw malformed('TypeSafe Choice selection does not match its probability distribution.')
  }
  return { type: 'choice', choice: value.choice, probabilities, confidence }
}

function validateScoreAnswer(value: unknown, question: ScoreQuestion): ScoreAnswer {
  if (!isObject(value) || !hasExactKeys(value, ['type', 'score', 'legend', 'probabilities', 'confidence'])
    || value.type !== 'score' || !isObject(value.legend) || !isObject(value.probabilities)) {
    throw malformed('TypeSafe returned an invalid Score answer.')
  }
  const expected = question.criteria.map((_, index) => String(index))
  const legend = value.legend
  const rawProbabilities = value.probabilities
  assertExactKeys(legend, expected, 'Score legend levels')
  assertExactKeys(rawProbabilities, expected, 'Score probability levels')
  expected.forEach((key, index) => {
    if (legend[key] !== question.criteria[index]) throw malformed('TypeSafe Score legend does not match the requested rubric.')
  })
  const probabilities = probabilityDistribution(rawProbabilities, 'Score')
  const confidence = probability(value.confidence, 'Score confidence')
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > question.criteria.length - 1) {
    throw malformed('TypeSafe Score value is outside its rubric.')
  }
  const weighted = expected.reduce((sum, key, index) => sum + index * probabilities[key]!, 0)
  // Each rounded probability can shift the weighted index by up to its level times the
  // rounding error, and the reported score is rounded as well.
  const scoreTolerance = PROBABILITY_SUM_TOLERANCE + REPORTED_ROUNDING_ERROR * expected.reduce((sum, _, index) => sum + index, 1)
  if (Math.abs(weighted - value.score) > scoreTolerance) {
    const distribution = expected.map((key) => `${key}: ${probabilities[key]}`).join(', ')
    throw malformed(`TypeSafe Score value does not match its probability distribution (score ${value.score}, weighted level index ${weighted.toFixed(4)}, probabilities {${distribution}}).`)
  }
  return { type: 'score', score: value.score, legend: legend as Record<string, string>, probabilities, confidence }
}

function validateNoulAnswer(value: unknown): NoulAnswer {
  if (!isObject(value) || !hasExactKeys(value, ['type', 'noul']) || value.type !== 'noul') {
    throw malformed('TypeSafe returned an invalid Noul answer.')
  }
  return { type: 'noul', noul: probability(value.noul, 'Noul yes probability') }
}

function probabilityDistribution(value: Record<string, unknown>, label: string): Record<string, number> {
  const output = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, probability(entry, `${label} probability`)]))
  const sum = Object.values(output).reduce((total, entry) => total + entry, 0)
  const sumTolerance = PROBABILITY_SUM_TOLERANCE + REPORTED_ROUNDING_ERROR * Object.keys(output).length
  if (Math.abs(sum - 1) > sumTolerance) {
    throw malformed(`${label} probabilities do not sum to one within ${Number(sumTolerance.toFixed(4))}.`)
  }
  return output
}

function probability(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw malformed(`${label} must be a finite number from zero to one.`)
  }
  return value
}

function classifyHttpFailure(status: number): TypeSafeTransportError {
  if (status === 401 || status === 403) {
    return new TypeSafeTransportError('typesafe_authentication_failed', 'TypeSafe rejected the API key. Update the System One extension credential.')
  }
  if (status === 402) return new TypeSafeTransportError('typesafe_quota_exhausted', 'TypeSafe quota or account credit is exhausted.')
  if (status === 408 || status === 504) return new TypeSafeTransportError('typesafe_timeout', 'TypeSafe evaluation timed out.')
  if (status === 429) return new TypeSafeTransportError('typesafe_rate_limited', 'TypeSafe rate limit exceeded. Wait before trying again; Forage did not retry automatically.')
  if (status === 529 || status >= 500) return new TypeSafeTransportError('typesafe_unavailable', 'TypeSafe is temporarily unavailable. Forage did not retry automatically.')
  if (status === 422 || status === 400) return new TypeSafeTransportError('typesafe_request_rejected', 'TypeSafe rejected the bounded evaluation request.')
  return new TypeSafeTransportError('typesafe_request_failed', `TypeSafe evaluation failed with HTTP status ${status}.`)
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new TypeSafeTransportError('typesafe_response_too_large', 'TypeSafe returned an oversized response.')
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function malformed(message: string): TypeSafeTransportError {
  return new TypeSafeTransportError('typesafe_malformed_response', message)
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw malformed(`TypeSafe returned missing, extra, or duplicate ${label}.`)
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function questionKey(index: number): string {
  return `candidate_${index}`
}

export function optionKey(index: number): string {
  return `option_${index}`
}
