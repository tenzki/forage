import type {
  ExtensionJsonObject,
  ExtensionSkillConfigurationIssue,
  ExtensionSkillConfigurationValidation,
} from '@forage/extension-api'

export const SYSTEM_ONE_MODELS = ['jev-latest', 'jev-preview', 'jev-1.13.0'] as const
export const SYSTEM_ONE_KINDS = ['choice-comparison', 'choice-classification', 'score', 'noul'] as const
export const CANDIDATE_SCOPES = ['siblings', 'descendants'] as const
export const RESULT_ORDERINGS = ['document', 'ascending', 'descending'] as const

export type SystemOneKind = typeof SYSTEM_ONE_KINDS[number]
export type CandidateScope = typeof CANDIDATE_SCOPES[number]
export type ResultOrdering = typeof RESULT_ORDERINGS[number]

export interface ChoiceCategory {
  id: string
  label: string
  description: string
}

export interface ScoreLevel {
  label: string
  description: string
}

interface SystemOneConfigurationBase {
  model: typeof SYSTEM_ONE_MODELS[number]
  kind: SystemOneKind
  question: string
  candidateScope: CandidateScope
  ordering: ResultOrdering
  decimalPlaces: number
}

export type SystemOneConfiguration = SystemOneConfigurationBase & (
  | { kind: 'choice-comparison' }
  | { kind: 'choice-classification'; categories: ChoiceCategory[] }
  | { kind: 'score'; levels: ScoreLevel[] }
  | { kind: 'noul'; yesDefinition?: string; noDefinition?: string; threshold: number }
)

const ALLOWED_KEYS = new Set([
  'model', 'kind', 'question', 'candidate_scope', 'ordering', 'decimal_places',
  'categories', 'levels', 'yes_definition', 'no_definition', 'threshold',
])
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/

export function validateSystemOneConfiguration(
  configuration: ExtensionJsonObject,
): ExtensionSkillConfigurationValidation {
  const result = parseSystemOneConfiguration(configuration)
  return result.ok ? { valid: true } : { valid: false, issues: result.issues }
}

export function requireSystemOneConfiguration(configuration: ExtensionJsonObject): SystemOneConfiguration {
  const result = parseSystemOneConfiguration(configuration)
  if (result.ok) return result.value
  throw new SystemOneConfigurationError(result.issues)
}

export class SystemOneConfigurationError extends Error {
  constructor(readonly issues: ReadonlyArray<ExtensionSkillConfigurationIssue>) {
    super(issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`).join('; '))
    this.name = 'SystemOneConfigurationError'
  }
}

type ParseResult =
  | { ok: true; value: SystemOneConfiguration }
  | { ok: false; issues: ExtensionSkillConfigurationIssue[] }

function parseSystemOneConfiguration(configuration: ExtensionJsonObject): ParseResult {
  const issues: ExtensionSkillConfigurationIssue[] = []
  for (const key of Object.keys(configuration)) {
    if (!ALLOWED_KEYS.has(key)) issue(issues, [key], 'Unsupported System One configuration field.')
  }

  const model = enumValue(configuration.model, SYSTEM_ONE_MODELS, ['model'], issues, 'Select a supported Jev model.')
  const kind = enumValue(configuration.kind, SYSTEM_ONE_KINDS, ['kind'], issues, 'Select a supported question type.')
  const question = boundedText(configuration.question, ['question'], issues, 2_000, true)
  const candidateScope = enumValue(
    configuration.candidate_scope, CANDIDATE_SCOPES, ['candidate_scope'], issues,
    'Select siblings or descendants.',
  )
  const ordering = enumValue(
    configuration.ordering, RESULT_ORDERINGS, ['ordering'], issues,
    'Select document, ascending, or descending order.',
  )
  const decimalPlaces = boundedNumber(configuration.decimal_places, ['decimal_places'], issues, 0, 6, true)

  if (!model || !kind || !question || !candidateScope || !ordering || decimalPlaces === undefined) {
    return { ok: false, issues }
  }

  const base: SystemOneConfigurationBase = {
    model,
    kind,
    question,
    candidateScope,
    ordering,
    decimalPlaces,
  }
  if (kind === 'choice-comparison') return finish(issues, { ...base, kind })
  if (kind === 'choice-classification') {
    const categories = parseCategories(configuration.categories, issues)
    if (!categories) return { ok: false, issues }
    return finish(issues, { ...base, kind, categories })
  }
  if (kind === 'score') {
    const levels = parseLevels(configuration.levels, issues)
    if (!levels) return { ok: false, issues }
    return finish(issues, { ...base, kind, levels })
  }
  const yesDefinition = optionalText(configuration.yes_definition, ['yes_definition'], issues, 1_000)
  const noDefinition = optionalText(configuration.no_definition, ['no_definition'], issues, 1_000)
  const threshold = boundedNumber(configuration.threshold, ['threshold'], issues, 0, 1, false)
  if (threshold === undefined) return { ok: false, issues }
  return finish(issues, {
    ...base,
    kind,
    ...(yesDefinition ? { yesDefinition } : {}),
    ...(noDefinition ? { noDefinition } : {}),
    threshold,
  })
}

function parseCategories(value: unknown, issues: ExtensionSkillConfigurationIssue[]): ChoiceCategory[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 50) {
    issue(issues, ['categories'], 'Choice classification requires between 2 and 50 categories.')
    return undefined
  }
  const categories = value.flatMap((entry, index): ChoiceCategory[] => {
    if (!isObject(entry)) {
      issue(issues, ['categories', index], 'Category must be an object.')
      return []
    }
    rejectUnknownKeys(entry, new Set(['id', 'label', 'description']), ['categories', index], issues)
    const id = boundedText(entry.id, ['categories', index, 'id'], issues, 64, true)
    const label = boundedText(entry.label, ['categories', index, 'label'], issues, 100, true)
    const description = boundedText(entry.description, ['categories', index, 'description'], issues, 1_000, true)
    if (id && !ID_PATTERN.test(id)) issue(issues, ['categories', index, 'id'], 'Category ID must start with a lowercase letter and use lowercase letters, numbers, underscores, or hyphens.')
    return id && label && description && ID_PATTERN.test(id) ? [{ id, label, description }] : []
  })
  reportDuplicate(categories, (entry) => entry.id, ['categories'], issues, 'Category IDs must be unique.')
  reportDuplicate(categories, (entry) => entry.label.toLocaleLowerCase('en-US'), ['categories'], issues, 'Category labels must be unique.')
  return categories.length === value.length ? categories : undefined
}

function parseLevels(value: unknown, issues: ExtensionSkillConfigurationIssue[]): ScoreLevel[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 10) {
    issue(issues, ['levels'], 'Score requires between 2 and 10 ordered levels.')
    return undefined
  }
  const levels = value.flatMap((entry, index): ScoreLevel[] => {
    if (!isObject(entry)) {
      issue(issues, ['levels', index], 'Score level must be an object.')
      return []
    }
    rejectUnknownKeys(entry, new Set(['label', 'description']), ['levels', index], issues)
    const label = boundedText(entry.label, ['levels', index, 'label'], issues, 100, true)
    const description = boundedText(entry.description, ['levels', index, 'description'], issues, 1_000, true)
    return label && description ? [{ label, description }] : []
  })
  reportDuplicate(levels, (entry) => entry.label.toLocaleLowerCase('en-US'), ['levels'], issues, 'Score level labels must be unique.')
  return levels.length === value.length ? levels : undefined
}

function finish(issues: ExtensionSkillConfigurationIssue[], value: SystemOneConfiguration): ParseResult {
  return issues.length ? { ok: false, issues } : { ok: true, value }
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: ReadonlyArray<string | number>,
  issues: ExtensionSkillConfigurationIssue[],
  message: string,
): T[number] | undefined {
  if (typeof value === 'string' && values.includes(value)) return value as T[number]
  issue(issues, path, message)
  return undefined
}

function boundedText(
  value: unknown,
  path: ReadonlyArray<string | number>,
  issues: ExtensionSkillConfigurationIssue[],
  maximum: number,
  required: boolean,
): string | undefined {
  if (typeof value !== 'string') {
    issue(issues, path, required ? 'A text value is required.' : 'Value must be text.')
    return undefined
  }
  const trimmed = value.trim()
  if ((required && !trimmed) || value.length > maximum) {
    issue(issues, path, `Value must be nonempty and no longer than ${maximum} characters.`)
    return undefined
  }
  return trimmed || undefined
}

function optionalText(
  value: unknown,
  path: ReadonlyArray<string | number>,
  issues: ExtensionSkillConfigurationIssue[],
  maximum: number,
): string | undefined {
  if (value === undefined || value === '') return undefined
  return boundedText(value, path, issues, maximum, false)
}

function boundedNumber(
  value: unknown,
  path: ReadonlyArray<string | number>,
  issues: ExtensionSkillConfigurationIssue[],
  minimum: number,
  maximum: number,
  integer: boolean,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    issue(issues, path, `Value must be a finite ${integer ? 'integer ' : ''}number from ${minimum} to ${maximum}.`)
    return undefined
  }
  return value
}

function reportDuplicate<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: ReadonlyArray<string | number>,
  issues: ExtensionSkillConfigurationIssue[],
  message: string,
): void {
  const seen = new Set<string>()
  if (values.some((entry) => seen.has(key(entry)) || !seen.add(key(entry)))) issue(issues, path, message)
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: ReadonlyArray<string | number>,
  issues: ExtensionSkillConfigurationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(issues, [...path, key], 'Unsupported field.')
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function issue(
  issues: ExtensionSkillConfigurationIssue[],
  path: ReadonlyArray<string | number>,
  message: string,
): void {
  issues.push({ path, message })
}

function formatPath(path: ReadonlyArray<string | number>): string {
  return path.length ? path.map(String).join('.') : 'configuration'
}
