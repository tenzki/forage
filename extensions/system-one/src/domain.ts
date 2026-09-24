import type {
  ExtensionJsonObject,
  ExtensionSkillConfigurationIssue,
  ExtensionSkillConfigurationValidation,
} from '@forage/extension-api'

export const SYSTEM_ONE_MODELS = ['jev-latest', 'jev-preview', 'jev-1.13.0'] as const
export const SYSTEM_ONE_KINDS = ['choice-comparison', 'choice-classification', 'score', 'noul'] as const
export const CANDIDATE_SCOPES = ['siblings', 'descendants'] as const
export const RESULT_OUTPUTS = ['list', 'reorder', 'tag'] as const

export type SystemOneKind = typeof SYSTEM_ONE_KINDS[number]
export type CandidateScope = typeof CANDIDATE_SCOPES[number]
export type ResultOutput = typeof RESULT_OUTPUTS[number]

export interface ChoiceCategory {
  label: string
  description: string
  /** Tag name without `#`: the configured tag, or one derived from the label. */
  tag?: string
}

export interface ScoreLevel {
  label: string
  description: string
}

interface SystemOneConfigurationBase {
  model: typeof SYSTEM_ONE_MODELS[number]
  kind: SystemOneKind
  /** Default question, used only when the invocation carries no typed text. */
  question?: string
  candidateScope: CandidateScope
  /** `reorder` moves and `tag` tags the candidate bullets instead of writing a result list. */
  output: ResultOutput
}

export type SystemOneConfiguration = SystemOneConfigurationBase & (
  | { kind: 'choice-comparison' }
  | { kind: 'choice-classification'; categories: ChoiceCategory[]; minimumProbability?: number }
  | { kind: 'score'; levels: ScoreLevel[] }
  | { kind: 'noul'; yesDefinition?: string; noDefinition?: string; threshold: number; tag?: string }
)

const ALLOWED_KEYS = new Set([
  'model', 'kind', 'question', 'candidate_scope', 'output',
  'categories', 'minimum_probability', 'levels', 'yes_definition', 'no_definition', 'threshold', 'tag',
])

const TAG_PATTERN = /^[\p{L}\p{N}_-]{1,64}$/u

/** Lowercase, hyphenate spaces, and drop characters an inline `#tag` cannot hold. */
export function tagFromLabel(label: string): string | undefined {
  const tag = label.toLocaleLowerCase('en-US').trim()
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
  return tag || undefined
}

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

/** Typed invocation text is the question; the configured question is only a default. */
export function resolveSystemOneQuestion(configuration: SystemOneConfiguration, prompt: string): string {
  const question = prompt.trim() || configuration.question
  if (!question) throw new Error('Type a question after the command; this skill has no default question.')
  return question
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
  const question = optionalText(configuration.question, ['question'], issues, 2_000)
  const candidateScope = enumValue(
    configuration.candidate_scope, CANDIDATE_SCOPES, ['candidate_scope'], issues,
    'Select siblings or descendants.',
  )
  // Skills saved before the output setting existed keep writing result lists.
  const output = configuration.output === undefined
    ? 'list'
    : enumValue(configuration.output, RESULT_OUTPUTS, ['output'], issues, 'Select list, reorder, or tag output.')

  if (!model || !kind || !candidateScope || !output) {
    return { ok: false, issues }
  }
  if (output === 'reorder' && candidateScope !== 'siblings') {
    issue(issues, ['candidate_scope'], 'Reordering bullets in place requires direct siblings.')
  }
  if (output === 'tag' && kind !== 'choice-classification' && kind !== 'noul') {
    issue(issues, ['output'], 'Tagging bullets requires Choice classification or Noul.')
  }

  const base: SystemOneConfigurationBase = {
    model,
    kind,
    ...(question ? { question } : {}),
    candidateScope,
    output,
  }
  if (kind === 'choice-comparison') return finish(issues, { ...base, kind })
  if (kind === 'choice-classification') {
    const categories = parseCategories(configuration.categories, output === 'tag', issues)
    const minimumProbability = configuration.minimum_probability === undefined
      ? undefined
      : boundedNumber(configuration.minimum_probability, ['minimum_probability'], issues, 0, 1, false)
    if (!categories) return { ok: false, issues }
    return finish(issues, {
      ...base,
      kind,
      categories,
      ...(minimumProbability !== undefined ? { minimumProbability } : {}),
    })
  }
  if (kind === 'score') {
    const levels = parseLevels(configuration.levels, issues)
    if (!levels) return { ok: false, issues }
    return finish(issues, { ...base, kind, levels })
  }
  const yesDefinition = optionalText(configuration.yes_definition, ['yes_definition'], issues, 1_000)
  const noDefinition = optionalText(configuration.no_definition, ['no_definition'], issues, 1_000)
  const threshold = boundedNumber(configuration.threshold, ['threshold'], issues, 0, 1, false)
  const tag = optionalTag(configuration.tag, ['tag'], issues)
  if (output === 'tag' && !tag && isBlank(configuration.tag)) {
    issue(issues, ['tag'], 'Tagging bullets requires a tag name.')
  }
  if (threshold === undefined) return { ok: false, issues }
  return finish(issues, {
    ...base,
    kind,
    ...(yesDefinition ? { yesDefinition } : {}),
    ...(noDefinition ? { noDefinition } : {}),
    threshold,
    ...(tag ? { tag } : {}),
  })
}

function parseCategories(
  value: unknown,
  tagged: boolean,
  issues: ExtensionSkillConfigurationIssue[],
): ChoiceCategory[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 50) {
    issue(issues, ['categories'], 'Choice classification requires between 2 and 50 categories.')
    return undefined
  }
  const categories = value.flatMap((entry, index): ChoiceCategory[] => {
    if (!isObject(entry)) {
      issue(issues, ['categories', index], 'Category must be an object.')
      return []
    }
    rejectUnknownKeys(entry, new Set(['label', 'description', 'tag']), ['categories', index], issues)
    const label = boundedText(entry.label, ['categories', index, 'label'], issues, 100, true)
    const description = boundedText(entry.description, ['categories', index, 'description'], issues, 1_000, true)
    const tag = optionalTag(entry.tag, ['categories', index, 'tag'], issues) ?? (label ? tagFromLabel(label) : undefined)
    if (tagged && label && !tag && isBlank(entry.tag)) {
      issue(issues, ['categories', index, 'tag'], 'This label has no characters a tag can use; set a tag.')
    }
    return label && description ? [{ label, description, ...(tag ? { tag } : {}) }] : []
  })
  reportDuplicate(categories, (entry) => entry.label.toLocaleLowerCase('en-US'), ['categories'], issues, 'Category labels must be unique.')
  if (tagged) {
    const tags = categories.flatMap((entry) => entry.tag ? [entry.tag] : [])
    reportDuplicate(tags, (tag) => tag, ['categories'], issues, 'Category tags must be unique.')
  }
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

/** An optional tag name; a leading `#` is accepted and dropped, case is folded. */
function optionalTag(
  value: unknown,
  path: ReadonlyArray<string | number>,
  issues: ExtensionSkillConfigurationIssue[],
): string | undefined {
  if (value === undefined || value === '') return undefined
  const tag = typeof value === 'string' ? value.trim().replace(/^#/, '').toLocaleLowerCase('en-US') : ''
  if (!TAG_PATTERN.test(tag)) {
    issue(issues, path, 'Tags use 1-64 letters, digits, underscores, or hyphens.')
    return undefined
  }
  return tag
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

/** Missing or empty; anything else was already checked by its parser. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === ''
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
