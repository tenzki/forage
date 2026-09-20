import { z } from 'zod'

export type {
  ExtensionJsonObject,
  ExtensionJsonValue,
  ExtensionLogEntry,
  ExtensionManifest,
  ExtensionProgress,
  ExtensionRunContext,
  ExtensionRunEndContext,
  ExtensionSettingDeclaration,
  ExtensionSettingValue,
  ExtensionSkillAdmittedPlan,
  ExtensionSkillConfigurationField,
  ExtensionSkillConfigurationForm,
  ExtensionSkillConfigurationValidation,
  ExtensionSkillContextNode,
  ExtensionSkillContextSnapshot,
  ExtensionSkillExecutionContext,
  ExtensionSkillExecutionInput,
  ExtensionSkillExecutorContribution,
  ExtensionSkillExecutorDefinition,
  ExtensionSkillPreparedPlan,
  ExtensionSkillPreparationContext,
  ExtensionSkillPreparationInput,
  ExtensionSkillResult,
  ExtensionSkillValidationContext,
  ExtensionSkillValidationInput,
  ExtensionToolDefinition,
  ExtensionToolExecutionContext,
  ExtensionToolInputSchema,
  ExtensionToolResult,
  ForageExtensionHost,
  ForageExtensionSetup,
} from '@forage/extension-api'
import type {
  ExtensionJsonObject,
  ExtensionJsonValue,
  ExtensionManifest,
  ExtensionSkillConfigurationField,
} from '@forage/extension-api'

export const RESERVED_EXTENSION_TOOL_IDS = [
  'emit_outline',
  'generate_image',
  'search_outline',
  'web_fetch',
  'web_search',
] as const

const MAX_MANIFEST_CHARS = 64_000
const MAX_JSON_CHARS = 100_000
const MAX_DIAGNOSTICS = 100
const MAX_EXTENSIONS = 128
const MAX_TOOLS = 64
const MAX_SETTINGS = 64
const MAX_EXECUTORS = 32
const MAX_FORM_FIELDS = 100
const MAX_FORM_BRANCHES = 32
const MAX_FORM_DEPTH = 6

export const extensionIdSchema = z.string().trim().min(3).max(128)
  .regex(
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/,
    'Extension id must be a reverse-DNS identifier',
  )
export const extensionInstallationIdSchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid installation identifier')
export const extensionToolIdSchema = z.string().trim().min(1).max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Invalid tool identifier')
const settingKeySchema = z.string().trim().min(1).max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Invalid setting key')
const semverSchema = z.string().trim().max(100)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    'Version must be valid semantic versioning',
  )
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a SHA-256 digest')
const boundedPathSchema = z.string().trim().min(1).max(2_048).refine(
  (value) => !value.includes('\0'),
  'Path contains a null byte',
)
const canonicalPathSchema = boundedPathSchema.refine(
  (value) => value.startsWith('/') || /^[A-Za-z]:\//.test(value),
  'Resolved paths must be absolute and use forward slashes',
)

function uniqueBy<T>(values: T[], key: (value: T) => string): boolean {
  const keys = values.map(key)
  return new Set(keys).size === keys.length
}

function isConfinedEntryPath(value: string): boolean {
  if (!value.startsWith('./') || value.includes('\\') || value.includes('\0')) return false
  const segments = value.slice(2).split('/')
  return segments.length > 0 && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

export const extensionEntryPathSchema = z.string().trim().min(3).max(500)
  .refine(isConfinedEntryPath, 'Entry must be a confined ./ path without traversal')
  .refine(
    (value) => /\.(?:c|m)?(?:js|ts)$/.test(value),
    'Entry must point to a JavaScript or TypeScript module',
  )

export const extensionToolContributionSchema = z.object({
  id: extensionToolIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
}).strict()

export const extensionHookNameSchema = z.enum(['run:start', 'run:end'])
export const extensionExecutorIdSchema = z.string().trim().min(1).max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, 'Invalid executor identifier')

const formFieldBase = {
  key: settingKeySchema,
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500).optional(),
  required: z.boolean().optional(),
}
const stringFormField = (type: 'text' | 'multiline') => z.object({
  ...formFieldBase,
  type: z.literal(type),
  default: z.string().max(type === 'text' ? 10_000 : 20_000).optional(),
  minLength: z.number().int().nonnegative().max(20_000).optional(),
  maxLength: z.number().int().positive().max(20_000).optional(),
}).strict().refine(
  (field) => field.minLength === undefined || field.maxLength === undefined || field.minLength <= field.maxLength,
  'Minimum length cannot exceed maximum length',
)

export const extensionSkillConfigurationFieldSchema: z.ZodType<ExtensionSkillConfigurationField> = z.lazy(() => z.discriminatedUnion('type', [
  stringFormField('text'),
  stringFormField('multiline'),
  z.object({
    ...formFieldBase,
    type: z.literal('number'),
    default: z.number().finite().optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    integer: z.boolean().optional(),
  }).strict().refine(
    (field) => field.minimum === undefined || field.maximum === undefined || field.minimum <= field.maximum,
    'Minimum cannot exceed maximum',
  ).refine(
    (field) => field.default === undefined
      || (field.minimum === undefined || field.default >= field.minimum)
      && (field.maximum === undefined || field.default <= field.maximum)
      && (!field.integer || Number.isInteger(field.default)),
    'Default must satisfy the declared numeric bounds',
  ),
  z.object({ ...formFieldBase, type: z.literal('boolean'), default: z.boolean().optional() }).strict(),
  z.object({
    ...formFieldBase,
    type: z.literal('choice'),
    options: z.array(z.object({
      value: z.string().min(1).max(200),
      label: z.string().trim().min(1).max(100),
      description: z.string().trim().min(1).max(500).optional(),
    }).strict()).min(1).max(50)
      .refine((options) => uniqueBy(options, (option) => option.value), 'Choice values must be unique'),
    default: z.string().min(1).max(200).optional(),
  }).strict().refine(
    (field) => field.default === undefined || field.options.some((option) => option.value === field.default),
    'Default must match a declared choice',
  ),
  z.object({
    ...formFieldBase,
    type: z.literal('object'),
    fields: z.array(extensionSkillConfigurationFieldSchema).min(1).max(MAX_FORM_FIELDS),
  }).strict(),
  z.object({
    ...formFieldBase,
    type: z.literal('repeat'),
    minimumItems: z.number().int().nonnegative().max(50).optional(),
    maximumItems: z.number().int().positive().max(50),
    fields: z.array(extensionSkillConfigurationFieldSchema).min(1).max(MAX_FORM_FIELDS),
  }).strict().refine(
    (field) => field.minimumItems === undefined || field.minimumItems <= field.maximumItems,
    'Minimum items cannot exceed maximum items',
  ),
]))

function validateFormFields(
  fields: readonly ExtensionSkillConfigurationField[],
  context: z.RefinementCtx,
  path: Array<string | number>,
  state: { count: number },
  depth = 1,
): void {
  if (depth > MAX_FORM_DEPTH) {
    context.addIssue({ code: 'custom', path, message: `Configuration form exceeds maximum depth of ${MAX_FORM_DEPTH}` })
    return
  }
  const keys = new Set<string>()
  fields.forEach((field, index) => {
    state.count += 1
    if (keys.has(field.key)) context.addIssue({ code: 'custom', path: [...path, index, 'key'], message: `Duplicate field key: ${field.key}` })
    keys.add(field.key)
    if (field.type === 'object' || field.type === 'repeat') {
      validateFormFields(field.fields, context, [...path, index, 'fields'], state, depth + 1)
    }
  })
}

export const extensionSkillConfigurationFormSchema = z.object({
  fields: z.array(extensionSkillConfigurationFieldSchema).max(MAX_FORM_FIELDS),
  branches: z.array(z.object({
    when: z.object({
      field: settingKeySchema,
      equals: z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()]),
    }).strict(),
    fields: z.array(extensionSkillConfigurationFieldSchema).min(1).max(MAX_FORM_FIELDS),
  }).strict()).max(MAX_FORM_BRANCHES).optional(),
}).strict().superRefine((form, context) => {
  const state = { count: 0 }
  validateFormFields(form.fields, context, ['fields'], state)
  form.branches?.forEach((branch, index) => validateFormFields(branch.fields, context, ['branches', index, 'fields'], state))
  if (state.count > MAX_FORM_FIELDS) context.addIssue({ code: 'custom', message: `Configuration form exceeds ${MAX_FORM_FIELDS} fields` })
  const rootKeys = new Set(form.fields.map((field) => field.key))
  form.branches?.forEach((branch, index) => {
    if (!rootKeys.has(branch.when.field)) {
      context.addIssue({ code: 'custom', path: ['branches', index, 'when', 'field'], message: 'Conditional field must reference a top-level field' })
    }
  })
})

export const extensionSkillExecutorContributionSchema = z.object({
  id: extensionExecutorIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  allowEmptyPrompt: z.boolean().optional(),
  configuration: extensionSkillConfigurationFormSchema,
}).strict()

const settingBase = {
  key: settingKeySchema,
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500).optional(),
  required: z.boolean().optional(),
}

export const extensionSettingDeclarationSchema = z.discriminatedUnion('type', [
  z.object({
    ...settingBase,
    type: z.literal('string'),
    default: z.string().max(10_000).optional(),
  }).strict(),
  z.object({
    ...settingBase,
    type: z.literal('multiline'),
    default: z.string().max(20_000).optional(),
  }).strict(),
  z.object({
    ...settingBase,
    type: z.literal('number'),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    default: z.number().finite().optional(),
  }).strict().refine(
    (setting) => setting.minimum === undefined || setting.maximum === undefined || setting.minimum <= setting.maximum,
    { message: 'Setting minimum cannot exceed maximum' },
  ).refine(
    (setting) => setting.default === undefined
      || (setting.minimum === undefined || setting.default >= setting.minimum)
      && (setting.maximum === undefined || setting.default <= setting.maximum),
    { message: 'Setting default must be inside its declared range' },
  ),
  z.object({
    ...settingBase,
    type: z.literal('boolean'),
    default: z.boolean().optional(),
  }).strict(),
  z.object({
    ...settingBase,
    type: z.literal('select'),
    options: z.array(z.object({
      value: z.string().min(1).max(200),
      label: z.string().trim().min(1).max(100),
    }).strict()).min(1).max(50)
      .refine((options) => uniqueBy(options, (option) => option.value), 'Select values must be unique'),
    default: z.string().min(1).max(200).optional(),
  }).strict().refine(
    (setting) => setting.default === undefined || setting.options.some((option) => option.value === setting.default),
    { message: 'Setting default must match a declared option' },
  ),
  z.object({
    ...settingBase,
    type: z.literal('secret'),
  }).strict(),
])

export const extensionManifestSchema: z.ZodType<ExtensionManifest> = z.object({
  id: extensionIdSchema,
  name: z.string().trim().min(1).max(100),
  version: semverSchema,
  description: z.string().trim().min(1).max(1_000),
  entry: extensionEntryPathSchema,
  contributes: z.object({
    tools: z.array(extensionToolContributionSchema).max(MAX_TOOLS)
      .refine((tools) => uniqueBy(tools, (tool) => tool.id), 'Tool identifiers must be unique'),
    hooks: z.array(extensionHookNameSchema).max(2)
      .refine((hooks) => new Set(hooks).size === hooks.length, 'Hook names must be unique'),
    settings: z.array(extensionSettingDeclarationSchema).max(MAX_SETTINGS)
      .refine((settings) => uniqueBy(settings, (setting) => setting.key), 'Setting keys must be unique'),
    executors: z.array(extensionSkillExecutorContributionSchema).max(MAX_EXECUTORS)
      .refine((executors) => uniqueBy(executors, (executor) => executor.id), 'Executor identifiers must be unique')
      .optional(),
  }).strict(),
}).strict()

export function parseExtensionManifest(serialized: string): ExtensionManifest {
  if (serialized.length > MAX_MANIFEST_CHARS) throw new Error('Extension manifest is too large')
  return extensionManifestSchema.parse(JSON.parse(serialized) as unknown)
}


const npmSpecSchema = z.string().trim().min(1).max(500)
  .regex(/^(?:npm:)?(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[^\s]+)?$/i, 'Invalid npm package specification')
const gitUrlSchema = z.string().trim().min(1).max(2_000).refine((value) => {
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(value)) return true
  try {
    const parsed = new URL(value)
    if (parsed.password) return false
    if (parsed.protocol === 'https:') return !parsed.username
    return parsed.protocol === 'ssh:'
  } catch {
    return false
  }
}, 'Git sources must use HTTPS or SSH')
const gitRefSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/+@{}-]*$/, 'Invalid Git ref')
  .refine((value) => !value.includes('..') && !value.includes('@{') && !value.endsWith('.') && !value.endsWith('.lock'), 'Invalid Git ref')

export const extensionSourceRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), path: boundedPathSchema }).strict(),
  z.object({ kind: z.literal('npm'), spec: npmSpecSchema }).strict(),
  z.object({
    kind: z.literal('git'),
    url: gitUrlSchema,
    ref: gitRefSchema.optional(),
  }).strict(),
])

export const extensionSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('drop-in'),
    installationId: extensionInstallationIdSchema,
    directoryName: z.string().min(1).max(255).regex(/^[^/\\]+$/),
    canonicalPath: canonicalPathSchema,
  }).strict(),
  z.object({
    kind: z.literal('local'),
    installationId: extensionInstallationIdSchema,
    requestedPath: boundedPathSchema,
    canonicalPath: canonicalPathSchema,
  }).strict(),
  z.object({
    kind: z.literal('npm'),
    installationId: extensionInstallationIdSchema,
    spec: npmSpecSchema,
    resolvedVersion: semverSchema,
    canonicalPath: canonicalPathSchema,
  }).strict(),
  z.object({
    kind: z.literal('git'),
    installationId: extensionInstallationIdSchema,
    url: gitUrlSchema,
    requestedRef: gitRefSchema.optional(),
    resolvedCommit: z.string().regex(/^[a-f0-9]{40}$/i),
    canonicalPath: canonicalPathSchema,
  }).strict(),
])

export type ExtensionSourceRequest = z.infer<typeof extensionSourceRequestSchema>
export type ExtensionSource = z.infer<typeof extensionSourceSchema>

export const extensionDiagnosticSchema = z.object({
  code: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().trim().min(1).max(2_000),
  path: z.string().trim().min(1).max(500).optional(),
  toolId: extensionToolIdSchema.optional(),
  executorId: extensionExecutorIdSchema.optional(),
}).strict()

export type ExtensionDiagnostic = z.infer<typeof extensionDiagnosticSchema>

export const extensionStatusSchema = z.enum([
  'needs_review',
  'disabled',
  'needs_configuration',
  'ready',
  'error',
])

export const extensionProvenanceSchema = z.object({
  installationId: extensionInstallationIdSchema,
  extensionId: extensionIdSchema,
  sourceKind: z.enum(['drop-in', 'local', 'npm', 'git']),
  sourceRevision: z.string().trim().min(1).max(200),
  entryDigest: digestSchema.optional(),
}).strict()

export const extensionCatalogToolSchema = extensionToolContributionSchema.extend({
  available: z.boolean(),
  globallyAuthorized: z.boolean(),
  diagnostics: z.array(extensionDiagnosticSchema).max(MAX_DIAGNOSTICS),
}).strict()

export const extensionCatalogExecutorSchema = extensionSkillExecutorContributionSchema.extend({
  available: z.boolean(),
  diagnostics: z.array(extensionDiagnosticSchema).max(MAX_DIAGNOSTICS),
}).strict()

export const extensionCatalogEntrySchema = z.object({
  source: extensionSourceSchema,
  manifest: extensionManifestSchema.optional(),
  provenance: extensionProvenanceSchema.optional(),
  status: extensionStatusSchema,
  tools: z.array(extensionCatalogToolSchema).max(MAX_TOOLS),
  executors: z.array(extensionCatalogExecutorSchema).max(MAX_EXECUTORS).optional(),
  diagnostics: z.array(extensionDiagnosticSchema).max(MAX_DIAGNOSTICS),
}).strict().superRefine((entry, context) => {
  const declaration = entry.manifest
  if (declaration && !entry.provenance) {
    context.addIssue({ code: 'custom', path: ['provenance'], message: 'Manifest-bearing catalog entries require provenance' })
  }
  if (!declaration && entry.provenance) {
    context.addIssue({ code: 'custom', path: ['provenance'], message: 'Provenance requires a valid manifest' })
  }
  if (declaration && entry.provenance && declaration.id !== entry.provenance.extensionId) {
    context.addIssue({ code: 'custom', path: ['provenance', 'extensionId'], message: 'Provenance extension id must match the manifest' })
  }
  if (entry.provenance && entry.provenance.installationId !== entry.source.installationId) {
    context.addIssue({ code: 'custom', path: ['provenance', 'installationId'], message: 'Provenance installation id must match the source' })
  }
  if (entry.provenance && entry.provenance.sourceKind !== entry.source.kind) {
    context.addIssue({ code: 'custom', path: ['provenance', 'sourceKind'], message: 'Provenance source kind must match the source' })
  }
  if (declaration) {
    const declared = declaration.contributes.tools.map((tool) => tool.id).sort()
    const cataloged = entry.tools.map((tool) => tool.id).sort()
    if (declared.length !== cataloged.length || declared.some((toolId, index) => toolId !== cataloged[index])) {
      context.addIssue({ code: 'custom', path: ['tools'], message: 'Catalog tools must exactly match manifest declarations' })
    }
    const declaredExecutors = 'executors' in declaration.contributes
      ? (declaration.contributes.executors ?? []).map((executor) => executor.id).sort()
      : []
    const catalogedExecutors = (entry.executors ?? []).map((executor) => executor.id).sort()
    if (declaredExecutors.length !== catalogedExecutors.length
      || declaredExecutors.some((executorId, index) => executorId !== catalogedExecutors[index])) {
      context.addIssue({ code: 'custom', path: ['executors'], message: 'Catalog executors must exactly match manifest declarations' })
    }
  } else if (entry.tools.length > 0) {
    context.addIssue({ code: 'custom', path: ['tools'], message: 'Catalog tools require a valid manifest' })
  } else if ((entry.executors?.length ?? 0) > 0) {
    context.addIssue({ code: 'custom', path: ['executors'], message: 'Catalog executors require a valid manifest' })
  }
  if (entry.status === 'ready' && (!entry.manifest || !entry.provenance)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Ready extensions require a valid manifest and provenance' })
  }
})

export const extensionCatalogSchema = z.object({
  version: z.literal(1),
  revision: digestSchema,
  entries: z.array(extensionCatalogEntrySchema).max(MAX_EXTENSIONS)
    .refine((entries) => uniqueBy(entries, (entry) => entry.source.installationId), 'Installation identifiers must be unique'),
}).strict()

export type ExtensionCatalog = z.infer<typeof extensionCatalogSchema>
export type ExtensionCatalogEntry = z.infer<typeof extensionCatalogEntrySchema>

const nonSecretSettingValueSchema = z.union([
  z.string().max(20_000),
  z.number().finite(),
  z.boolean(),
])

export const extensionSecretReferenceSchema = z.string().trim().min(1).max(300)
  .regex(
    /^forage-extension\/[A-Za-z0-9][A-Za-z0-9._:-]*\/[a-z][a-z0-9_]*$/,
    'Invalid extension secret reference',
  )

export const extensionSourceConfigurationSchema = z.object({
  installationId: extensionInstallationIdSchema,
  source: extensionSourceRequestSchema,
  enabled: z.boolean(),
  trust: z.object({
    accepted: z.boolean(),
    extensionId: extensionIdSchema.optional(),
  }).strict(),
  settings: z.record(settingKeySchema, nonSecretSettingValueSchema)
    .refine((settings) => Object.keys(settings).length <= MAX_SETTINGS, 'Too many extension settings'),
  secretReferences: z.record(settingKeySchema, extensionSecretReferenceSchema)
    .refine((references) => Object.keys(references).length <= MAX_SETTINGS, 'Too many extension secret references')
    .optional(),
  resolvedSource: extensionSourceSchema.optional(),
}).strict().refine(
  (source) => !source.enabled || source.trust.accepted,
  { path: ['enabled'], message: 'An extension cannot be enabled before trust is accepted' },
).refine(
  (source) => !source.trust.accepted || source.trust.extensionId !== undefined,
  { path: ['trust', 'extensionId'], message: 'Accepted trust must be bound to an extension identity' },
).superRefine((source, context) => {
  for (const [key, reference] of Object.entries(source.secretReferences ?? {})) {
    if (reference !== `forage-extension/${source.installationId}/${key}`) {
      context.addIssue({
        code: 'custom',
        path: ['secretReferences', key],
        message: 'Secret reference must be scoped to its installation and setting key',
      })
    }
  }
  if (source.resolvedSource) {
    if (source.resolvedSource.installationId !== source.installationId) {
      context.addIssue({
        code: 'custom',
        path: ['resolvedSource', 'installationId'],
        message: 'Resolved source installation id must match its configuration',
      })
    }
    if (source.resolvedSource.kind !== source.source.kind) {
      context.addIssue({
        code: 'custom',
        path: ['resolvedSource', 'kind'],
        message: 'Resolved source kind must match its request',
      })
    }
  }
  if ((source.source.kind === 'npm' || source.source.kind === 'git') && !source.resolvedSource) {
    context.addIssue({
      code: 'custom',
      path: ['resolvedSource'],
      message: 'Managed sources require resolved installation metadata',
    })
  }
})

export type ExtensionSourceConfiguration = z.infer<typeof extensionSourceConfigurationSchema>

export const extensionConfigurationSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  sources: z.array(extensionSourceConfigurationSchema).max(MAX_EXTENSIONS)
    .refine((sources) => uniqueBy(sources, (source) => source.installationId), 'Installation identifiers must be unique'),
}).strict()

export type ExtensionConfiguration = z.infer<typeof extensionConfigurationSchema>

const extensionSnapshotSourceSchema = z.object({
  installationId: extensionInstallationIdSchema,
  extensionId: extensionIdSchema,
  sourceRevision: z.string().trim().min(1).max(200),
  entryDigest: digestSchema,
  toolIds: z.array(extensionToolIdSchema).max(MAX_TOOLS)
    .refine((ids) => new Set(ids).size === ids.length, 'Tool identifiers must be unique'),
  hooks: z.array(extensionHookNameSchema).max(2)
    .refine((hooks) => new Set(hooks).size === hooks.length, 'Hook names must be unique'),
}).strict()

export const localExtensionSnapshotSchema = z.object({
  version: z.literal(1),
  catalogRevision: digestSchema,
  configurationRevision: z.number().int().nonnegative(),
  sources: z.array(extensionSnapshotSourceSchema).max(MAX_EXTENSIONS)
    .refine((sources) => uniqueBy(sources, (source) => source.installationId), 'Installation identifiers must be unique'),
}).strict().superRefine((snapshot, context) => {
  if (!uniqueBy(snapshot.sources, (source) => source.extensionId)) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'Extension identifiers must be unique in an admitted snapshot' })
  }
  const toolIds = snapshot.sources.flatMap((source) => source.toolIds)
  if (new Set(toolIds).size !== toolIds.length) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'Tool providers must be unique in an admitted snapshot' })
  }
})

export type LocalExtensionSnapshot = z.infer<typeof localExtensionSnapshotSchema>

export const localExtensionExecutorSnapshotSchema = z.object({
  version: z.literal(1),
  catalogRevision: digestSchema,
  configurationRevision: z.number().int().nonnegative(),
  source: z.object({
    installationId: extensionInstallationIdSchema,
    extensionId: extensionIdSchema,
    sourceRevision: z.string().trim().min(1).max(200),
    entryDigest: digestSchema,
    executorId: extensionExecutorIdSchema,
  }).strict(),
}).strict()

export type LocalExtensionExecutorSnapshot = z.infer<typeof localExtensionExecutorSnapshotSchema>

export function createLocalExtensionExecutorSnapshotFromCatalog(
  catalog: ExtensionCatalog,
  configurationRevision: number,
  selection: { extensionId: string; executorId: string },
): LocalExtensionExecutorSnapshot {
  const matches = catalog.entries.filter((entry) => (
    entry.status === 'ready'
    && entry.manifest?.id === selection.extensionId
    && entry.provenance?.entryDigest
    && (entry.executors ?? []).some((executor) => executor.id === selection.executorId && executor.available)
  ))
  if (matches.length !== 1) throw new Error('Selected extension skill executor is unavailable or has conflicting ownership')
  const entry = matches[0]!
  return localExtensionExecutorSnapshotSchema.parse({
    version: 1,
    catalogRevision: catalog.revision,
    configurationRevision,
    source: {
      installationId: entry.source.installationId,
      extensionId: selection.extensionId,
      sourceRevision: entry.provenance!.sourceRevision,
      entryDigest: entry.provenance!.entryDigest,
      executorId: selection.executorId,
    },
  })
}

export function createLocalExtensionSnapshotFromCatalog(
  catalog: ExtensionCatalog,
  configurationRevision: number,
  admittedToolIds: readonly string[],
): LocalExtensionSnapshot {
  const admitted = new Set(admittedToolIds)
  return localExtensionSnapshotSchema.parse({
    version: 1,
    catalogRevision: catalog.revision,
    configurationRevision,
    sources: catalog.entries.flatMap((entry) => {
      if (entry.status !== 'ready' || !entry.manifest || !entry.provenance?.entryDigest) return []
      const toolIds = entry.tools
        .filter((tool) => tool.available && admitted.has(tool.id))
        .map((tool) => tool.id)
        .sort()
      const hooks = [...entry.manifest.contributes.hooks].sort()
      if (toolIds.length === 0 && hooks.length === 0) return []
      return [{
        installationId: entry.source.installationId,
        extensionId: entry.manifest.id,
        sourceRevision: entry.provenance.sourceRevision,
        entryDigest: entry.provenance.entryDigest,
        toolIds,
        hooks,
      }]
    }),
  })
}

const managementRequestBase = {
  version: z.literal(1),
  kind: z.literal('request'),
  requestId: extensionInstallationIdSchema,
}
const installationOperation = <T extends string>(operation: T) => z.object({
  ...managementRequestBase,
  operation: z.literal(operation),
  installationId: extensionInstallationIdSchema,
}).strict()

export const extensionManagementOperationSchema = z.enum([
  'inventory',
  'preview_install',
  'validate',
  'configuration_status',
  'configure',
  'install',
  'enable',
  'disable',
  'reload',
  'check_updates',
  'update',
  'remove',
])

export const extensionManagementRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...managementRequestBase, operation: z.literal('inventory') }).strict(),
  z.object({
    ...managementRequestBase,
    operation: z.literal('preview_install'),
    source: extensionSourceRequestSchema,
  }).strict(),
  installationOperation('validate'),
  installationOperation('configuration_status'),
  z.object({
    ...managementRequestBase,
    operation: z.literal('configure'),
    installationId: extensionInstallationIdSchema,
    settings: z.record(settingKeySchema, nonSecretSettingValueSchema)
      .refine((settings) => Object.keys(settings).length <= MAX_SETTINGS, 'Too many extension settings'),
    secretReferences: z.record(settingKeySchema, extensionSecretReferenceSchema)
      .refine((references) => Object.keys(references).length <= MAX_SETTINGS, 'Too many extension secret references'),
  }).strict(),
  z.object({
    ...managementRequestBase,
    operation: z.literal('install'),
    source: extensionSourceRequestSchema,
    previewId: extensionInstallationIdSchema.optional(),
  }).strict(),
  z.object({
    ...managementRequestBase,
    operation: z.literal('enable'),
    installationId: extensionInstallationIdSchema,
    trustAccepted: z.literal(true),
  }).strict(),
  installationOperation('disable'),
  installationOperation('reload'),
  installationOperation('check_updates'),
  installationOperation('update'),
  installationOperation('remove'),
])

const managementSuccessSchema = z.object({
  version: z.literal(1),
  kind: z.literal('response'),
  requestId: extensionInstallationIdSchema,
  operation: extensionManagementOperationSchema,
  ok: z.literal(true),
  catalog: extensionCatalogSchema.optional(),
  configuration: extensionConfigurationSchema.optional(),
  extensionsDirectory: canonicalPathSchema.optional(),
  entry: extensionCatalogEntrySchema.optional(),
  removedInstallationId: extensionInstallationIdSchema.optional(),
  update: z.object({
    available: z.boolean(),
    revision: z.string().trim().min(1).max(200).optional(),
  }).strict().optional(),
  preview: z.object({
    previewId: extensionInstallationIdSchema,
    requestedSource: extensionSourceRequestSchema,
    entry: extensionCatalogEntrySchema,
  }).strict().optional(),
}).strict().refine(
  (response) => [response.catalog, response.entry, response.removedInstallationId, response.update, response.preview]
    .filter((value) => value !== undefined).length === 1,
  'Successful management responses must contain exactly one result',
).refine(
  (response) => response.operation === 'inventory'
    ? response.catalog !== undefined && response.configuration !== undefined && response.extensionsDirectory !== undefined
    : response.operation === 'remove'
      ? response.removedInstallationId !== undefined
      : response.operation === 'preview_install'
        ? response.preview !== undefined
      : response.operation === 'check_updates'
        ? response.update !== undefined
        : response.entry !== undefined,
  'Management response result does not match its operation',
)
const managementFailureSchema = z.object({
  version: z.literal(1),
  kind: z.literal('response'),
  requestId: extensionInstallationIdSchema,
  operation: extensionManagementOperationSchema,
  ok: z.literal(false),
  diagnostics: z.array(extensionDiagnosticSchema).min(1).max(MAX_DIAGNOSTICS),
}).strict()

export const extensionManagementResponseSchema = z.discriminatedUnion('ok', [
  managementSuccessSchema,
  managementFailureSchema,
])
export const extensionManagementMessageSchema = z.union([
  extensionManagementRequestSchema,
  extensionManagementResponseSchema,
])

export type ExtensionManagementRequest = z.infer<typeof extensionManagementRequestSchema>
export type ExtensionManagementResponse = z.infer<typeof extensionManagementResponseSchema>

export const extensionJsonValueSchema: z.ZodType<ExtensionJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(50_000),
  z.array(extensionJsonValueSchema).max(1_000),
  z.record(z.string().max(100), extensionJsonValueSchema)
    .refine((value) => Object.keys(value).length <= 100, 'JSON object has too many keys'),
]))

const SECRET_LIKE_KEY = /(?:^|_)(?:api_?key|access_?token|refresh_?token|password|authorization|secret)(?:$|_)/i
const DEVICE_AUTHORITY_KEY = /^(?:path|canonicalpath|requestedpath|sourcepath|entrypath|installpath|installationpath|trust|trusted|truststate|truststatus)$/

function isDeviceAuthorityKey(key: string): boolean {
  return DEVICE_AUTHORITY_KEY.test(key.replace(/[^A-Za-z0-9]/g, '').toLowerCase())
}

function jsonObjectIsPortable(value: unknown, depth = 0, state = { nodes: 0 }): boolean {
  state.nodes += 1
  if (state.nodes > 2_000 || depth > 8) return false
  if (Array.isArray(value)) return value.every((entry) => jsonObjectIsPortable(entry, depth + 1, state))
  if (!value || typeof value !== 'object') return true
  return Object.entries(value as Record<string, unknown>).every(([key, entry]) => (
    !SECRET_LIKE_KEY.test(key) && !isDeviceAuthorityKey(key) && jsonObjectIsPortable(entry, depth + 1, state)
  ))
}
export const extensionJsonObjectSchema: z.ZodType<ExtensionJsonObject> = z.record(
  z.string().min(1).max(100),
  extensionJsonValueSchema,
).refine((value) => Object.keys(value).length <= 100, 'JSON object has too many keys')
  .refine(
    (value) => jsonObjectIsPortable(value),
    'Portable configuration exceeds JSON depth/count bounds or contains a secret, device path, or trust field',
  )
  .refine((value) => serializedJsonIsBounded(value), 'JSON object is too large')

export interface ExtensionSkillConfigurationValidationIssue {
  path: Array<string | number>
  message: string
}

export function validateExtensionSkillConfiguration(
  formValue: unknown,
  configurationValue: unknown,
): { valid: true } | { valid: false; issues: ExtensionSkillConfigurationValidationIssue[] } {
  const form = extensionSkillConfigurationFormSchema.parse(formValue)
  const configuration = extensionJsonObjectSchema.parse(configurationValue)
  const issues: ExtensionSkillConfigurationValidationIssue[] = []
  const activeFields = [
    ...form.fields,
    ...(form.branches ?? []).flatMap((branch) => configuration[branch.when.field] === branch.when.equals ? branch.fields : []),
  ]
  const validateFields = (
    fields: readonly ExtensionSkillConfigurationField[],
    value: ExtensionJsonObject,
    path: Array<string | number>,
    retainedFields: readonly ExtensionSkillConfigurationField[] = [],
  ): void => {
    const declared = new Set([...fields, ...retainedFields].map((field) => field.key))
    Object.keys(value).filter((key) => !declared.has(key)).forEach((key) => issues.push({ path: [...path, key], message: 'Unknown configuration field.' }))
    fields.forEach((field) => {
      const fieldValue = value[field.key]
      const fieldPath = [...path, field.key]
      if (fieldValue === undefined) {
        if (field.required) issues.push({ path: fieldPath, message: 'This field is required.' })
        return
      }
      if (field.type === 'text' || field.type === 'multiline') {
        if (typeof fieldValue !== 'string'
          || (field.minLength !== undefined && fieldValue.length < field.minLength)
          || (field.maxLength !== undefined && fieldValue.length > field.maxLength)) {
          issues.push({ path: fieldPath, message: 'Value does not satisfy the declared text bounds.' })
        }
      } else if (field.type === 'number') {
        if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)
          || (field.minimum !== undefined && fieldValue < field.minimum)
          || (field.maximum !== undefined && fieldValue > field.maximum)
          || (field.integer && !Number.isInteger(fieldValue))) {
          issues.push({ path: fieldPath, message: 'Value does not satisfy the declared numeric bounds.' })
        }
      } else if (field.type === 'boolean') {
        if (typeof fieldValue !== 'boolean') issues.push({ path: fieldPath, message: 'Expected a boolean.' })
      } else if (field.type === 'choice') {
        if (typeof fieldValue !== 'string' || !field.options.some((option) => option.value === fieldValue)) {
          issues.push({ path: fieldPath, message: 'Value is not a declared choice.' })
        }
      } else if (field.type === 'object') {
        if (!fieldValue || typeof fieldValue !== 'object' || Array.isArray(fieldValue)) issues.push({ path: fieldPath, message: 'Expected an object.' })
        else validateFields(field.fields, fieldValue as ExtensionJsonObject, fieldPath)
      } else if (field.type === 'repeat') {
        if (!Array.isArray(fieldValue)
          || (field.minimumItems !== undefined && fieldValue.length < field.minimumItems)
          || fieldValue.length > field.maximumItems) {
          issues.push({ path: fieldPath, message: 'Repeated group does not satisfy its item bounds.' })
        } else fieldValue.forEach((item, index) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) issues.push({ path: [...fieldPath, index], message: 'Expected an object.' })
          else validateFields(field.fields, item as ExtensionJsonObject, [...fieldPath, index])
        })
      }
    })
  }
  validateFields(activeFields, configuration, [], (form.branches ?? []).flatMap((branch) => branch.fields))
  return issues.length ? { valid: false, issues: issues.slice(0, 100) } : { valid: true }
}

function serializedJsonIsBounded(value: unknown, maximum = MAX_JSON_CHARS): boolean {
  try {
    return JSON.stringify(value).length <= maximum
  } catch {
    return false
  }
}

export const extensionToolInputSchemaSchema = z.record(z.string().max(100), extensionJsonValueSchema)
  .refine((value) => Object.keys(value).length <= 100, 'Tool input schema has too many keys')
  .refine((value) => serializedJsonIsBounded(value, 20_000), 'Tool input schema is too large')

export const extensionToolResultSchema = z.union([
  z.object({ text: z.string().max(100_000) }).strict(),
  z.object({ json: extensionJsonValueSchema }).strict(),
]).refine(serializedJsonIsBounded, 'Extension tool result is too large')

export const extensionProgressSchema = z.object({
  message: z.string().trim().min(1).max(500),
  completed: z.number().finite().nonnegative().optional(),
  total: z.number().finite().positive().optional(),
}).strict().refine(
  (progress) => progress.completed === undefined || progress.total === undefined || progress.completed <= progress.total,
  'Progress completed cannot exceed total',
)

export const extensionLogEntrySchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().trim().min(1).max(2_000),
  data: extensionJsonValueSchema.optional(),
}).strict().refine(serializedJsonIsBounded, 'Extension log entry is too large')

export const extensionCollisionInputSchema = z.object({
  installationId: extensionInstallationIdSchema,
  extensionId: extensionIdSchema,
  toolIds: z.array(extensionToolIdSchema).max(MAX_TOOLS)
    .refine((ids) => new Set(ids).size === ids.length, 'Tool identifiers must be unique'),
}).strict()

export type ExtensionCollisionInput = z.infer<typeof extensionCollisionInputSchema>

export interface ExtensionToolAvailability {
  installationId: string
  extensionId: string
  toolId: string
  available: boolean
  diagnosticCode?: 'duplicate_extension_id' | 'duplicate_tool_provider' | 'custom_tool_collision' | 'reserved_tool_id'
  conflictingInstallationIds: string[]
}

export interface ExtensionExecutorAvailability {
  installationId: string
  extensionId: string
  executorId: string
  available: boolean
  diagnosticCode?: 'duplicate_extension_id' | 'duplicate_executor_identity'
  conflictingInstallationIds: string[]
}

export function resolveExtensionExecutorAvailability(
  inputs: ReadonlyArray<{ installationId: string; extensionId: string; executorIds: readonly string[] }>,
): ExtensionExecutorAvailability[] {
  const parsed = z.array(z.object({
    installationId: extensionInstallationIdSchema,
    extensionId: extensionIdSchema,
    executorIds: z.array(extensionExecutorIdSchema).max(MAX_EXECUTORS)
      .refine((ids) => new Set(ids).size === ids.length, 'Executor identifiers must be unique'),
  }).strict()).max(MAX_EXTENSIONS)
    .refine((entries) => uniqueBy(entries, (entry) => entry.installationId), 'Installation identifiers must be unique')
    .parse(inputs)
  const ordered = [...parsed].sort((left, right) => left.installationId.localeCompare(right.installationId))
  const extensionOwners = new Map<string, string[]>()
  const executorOwners = new Map<string, string[]>()
  for (const input of ordered) {
    extensionOwners.set(input.extensionId, [...(extensionOwners.get(input.extensionId) ?? []), input.installationId])
    for (const executorId of input.executorIds) {
      const identity = `${input.extensionId}/${executorId}`
      executorOwners.set(identity, [...(executorOwners.get(identity) ?? []), input.installationId])
    }
  }
  return ordered.flatMap((input) => [...input.executorIds].sort().map((executorId) => {
    const duplicateExtensions = extensionOwners.get(input.extensionId) ?? []
    const executors = executorOwners.get(`${input.extensionId}/${executorId}`) ?? []
    const conflict = duplicateExtensions.length > 1
      ? { code: 'duplicate_extension_id' as const, ids: duplicateExtensions }
      : executors.length > 1
        ? { code: 'duplicate_executor_identity' as const, ids: executors }
        : undefined
    return {
      installationId: input.installationId,
      extensionId: input.extensionId,
      executorId,
      available: conflict === undefined,
      ...(conflict ? { diagnosticCode: conflict.code } : {}),
      conflictingInstallationIds: conflict?.ids.filter((id) => id !== input.installationId).sort() ?? [],
    }
  }))
}

export function resolveExtensionToolAvailability(
  inputs: readonly ExtensionCollisionInput[],
  customHttpToolIds: readonly string[] = [],
): ExtensionToolAvailability[] {
  const parsedInputs = z.array(extensionCollisionInputSchema).max(MAX_EXTENSIONS)
    .refine((entries) => uniqueBy(entries, (entry) => entry.installationId), 'Installation identifiers must be unique')
    .parse(inputs)
  const parsedCustomHttpToolIds = z.array(extensionToolIdSchema).max(MAX_TOOLS)
    .refine((ids) => new Set(ids).size === ids.length, 'Custom HTTP tool identifiers must be unique')
    .parse(customHttpToolIds)
  const ordered = [...parsedInputs].sort((left, right) => (
    left.installationId.localeCompare(right.installationId) || left.extensionId.localeCompare(right.extensionId)
  ))
  const extensionProviders = new Map<string, string[]>()
  const toolProviders = new Map<string, string[]>()
  for (const input of ordered) {
    extensionProviders.set(input.extensionId, [...(extensionProviders.get(input.extensionId) ?? []), input.installationId])
    for (const toolId of input.toolIds) {
      toolProviders.set(toolId, [...(toolProviders.get(toolId) ?? []), input.installationId])
    }
  }
  const reserved = new Set<string>(RESERVED_EXTENSION_TOOL_IDS)
  const custom = new Set(parsedCustomHttpToolIds)
  const output: ExtensionToolAvailability[] = []
  for (const input of ordered) {
    const duplicateExtensions = extensionProviders.get(input.extensionId) ?? []
    for (const toolId of [...input.toolIds].sort()) {
      const providers = toolProviders.get(toolId) ?? []
      const conflict = duplicateExtensions.length > 1
        ? { code: 'duplicate_extension_id' as const, ids: duplicateExtensions }
        : reserved.has(toolId)
          ? { code: 'reserved_tool_id' as const, ids: [] }
          : custom.has(toolId)
            ? { code: 'custom_tool_collision' as const, ids: [] }
            : providers.length > 1
              ? { code: 'duplicate_tool_provider' as const, ids: providers }
              : undefined
      output.push({
        installationId: input.installationId,
        extensionId: input.extensionId,
        toolId,
        available: conflict === undefined,
        ...(conflict ? { diagnosticCode: conflict.code } : {}),
        conflictingInstallationIds: conflict?.ids.filter((id) => id !== input.installationId).sort() ?? [],
      })
    }
  }
  return output
}
