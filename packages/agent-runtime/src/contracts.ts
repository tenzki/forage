import { z } from 'zod'
import type { ExtensionSkillContextNode } from '@forage/extension-api'
import {
  extensionExecutorIdSchema,
  extensionIdSchema,
  extensionJsonObjectSchema,
  localExtensionSnapshotSchema,
  localExtensionExecutorSnapshotSchema,
} from './extensions'

const MAX_AGENT_PROMPT_CHARS = 20_000
const MAX_NODE_DEPTH = 8
const MAX_NODE_COUNT = 500
const MAX_NODE_TEXT_CHARS = 20_000
const MAX_RESULT_TEXT_CHARS = 100_000
const MAX_RESULT_SEGMENTS = 2_000
const MAX_EXTENSION_CONTEXT_CHARS = 40_000
const MAX_EXTENSION_CONTEXT_NODES = 100
const MAX_PREPARED_PLAN_IDS = 100
const MAX_PREVIEW_ANNOTATIONS = 200

export const runtimeIdSchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid identifier')
const definitionIdSchema = z.string().trim().min(1).max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Invalid definition identifier')
const toolIdSchema = z.string().trim().min(1).max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Invalid tool identifier')
const uniqueToolIdsSchema = z.array(toolIdSchema).max(64)
  .refine((ids) => new Set(ids).size === ids.length, 'Tool identifiers must be unique')

export const portableAgentDefinitionSchema = z.object({
  id: definitionIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300),
  systemPrompt: z.string().trim().min(1).max(MAX_AGENT_PROMPT_CHARS),
  toolIds: uniqueToolIdsSchema,
}).strict()

/** @deprecated Read-only compatibility shape for configuration version 1. */
export const legacyAgentDefinitionSchema = portableAgentDefinitionSchema.extend({
  modelId: z.string().trim().max(128).refine(
    (value) => !value || /^[A-Za-z0-9._:/-]+$/.test(value),
    'Invalid model identifier',
  ),
  credentialRef: runtimeIdSchema.optional(),
}).strict()

export const agentDefinitionSchema = legacyAgentDefinitionSchema
export type AgentDefinition = z.infer<typeof legacyAgentDefinitionSchema>
export type PortableAgentDefinition = z.infer<typeof portableAgentDefinitionSchema>

const skillBaseShape = {
  id: definitionIdSchema,
  label: z.string().trim().regex(/^[a-z][a-z0-9-]{1,31}$/),
  description: z.string().trim().min(1).max(300),
}

/** @deprecated Read-only compatibility shape for configuration versions 1 and 2. */
export const legacySkillDefinitionSchema = z.object({
  ...skillBaseShape,
  systemPrompt: z.string().trim().min(1).max(MAX_AGENT_PROMPT_CHARS),
  agentId: definitionIdSchema,
  requiredToolIds: uniqueToolIdsSchema,
}).strict()

export const llmSkillDefinitionSchema = z.object({
  ...skillBaseShape,
  execution: z.literal('llm'),
  systemPrompt: z.string().trim().min(1).max(MAX_AGENT_PROMPT_CHARS),
  agentId: definitionIdSchema,
  requiredToolIds: uniqueToolIdsSchema,
}).strict()

export const extensionSkillExecutorReferenceSchema = z.object({
  extensionId: extensionIdSchema,
  executorId: extensionExecutorIdSchema,
}).strict()

export const extensionSkillDefinitionSchema = z.object({
  ...skillBaseShape,
  execution: z.literal('extension'),
  executor: extensionSkillExecutorReferenceSchema,
  configuration: extensionJsonObjectSchema,
}).strict()

export const skillDefinitionSchema = z.discriminatedUnion('execution', [
  llmSkillDefinitionSchema,
  extensionSkillDefinitionSchema,
])

export type LegacySkillDefinition = z.infer<typeof legacySkillDefinitionSchema>
export type LlmSkillDefinition = z.infer<typeof llmSkillDefinitionSchema>
export type ExtensionSkillExecutorReference = z.infer<typeof extensionSkillExecutorReferenceSchema>
export type ExtensionSkillDefinition = z.infer<typeof extensionSkillDefinitionSchema>
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>

export const customToolDefinitionSchema = z.object({
  id: definitionIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  urlTemplate: z.string().trim().min(1).max(2_000).superRefine((value, context) => {
    let url: URL
    try {
      url = new URL(value.replace(/\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g, 'value'))
    } catch {
      context.addIssue({ code: 'custom', message: 'Tool URL template is invalid' })
      return
    }
    if (url.username || url.password) {
      context.addIssue({ code: 'custom', message: 'Tool URL cannot contain credentials' })
    }
    if (url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'Tool URL must use HTTPS' })
    }
  }),
}).strict()

export type CustomToolDefinition = z.infer<typeof customToolDefinitionSchema>

function duplicate(values: string[]): string | undefined {
  const seen = new Set<string>()
  return values.find((value) => seen.has(value) || !seen.add(value))
}

export const legacyAgentConfigurationSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  agents: z.array(agentDefinitionSchema).max(100),
  skills: z.array(legacySkillDefinitionSchema).max(200),
  customTools: z.array(customToolDefinitionSchema).max(100),
  globallyEnabledToolIds: uniqueToolIdsSchema,
}).strict().superRefine(validateConfiguration)

/** @deprecated Read-only compatibility shape for portable configuration version 2. */
export const portableAgentConfigurationV2Schema = z.object({
  version: z.literal(2),
  revision: z.number().int().nonnegative(),
  agents: z.array(portableAgentDefinitionSchema).max(100),
  skills: z.array(legacySkillDefinitionSchema).max(200),
  customTools: z.array(customToolDefinitionSchema).max(100),
  globallyEnabledToolIds: uniqueToolIdsSchema,
}).strict().superRefine(validateConfiguration)

export const portableAgentConfigurationSchema = z.object({
  version: z.literal(3),
  revision: z.number().int().nonnegative(),
  agents: z.array(portableAgentDefinitionSchema).max(100),
  skills: z.array(skillDefinitionSchema).max(200),
  customTools: z.array(customToolDefinitionSchema).max(100),
  globallyEnabledToolIds: uniqueToolIdsSchema,
}).strict().superRefine(validateConfiguration)

function validateConfiguration(
  configuration: {
    agents: Array<{ id: string }>
    skills: Array<{ id: string; execution?: 'llm' | 'extension'; agentId?: string }>
    customTools: Array<{ id: string }>
  },
  context: z.RefinementCtx,
) {
  const duplicateAgentId = duplicate(configuration.agents.map((agent) => agent.id))
  if (duplicateAgentId) {
    context.addIssue({ code: 'custom', path: ['agents'], message: `Duplicate agent id: ${duplicateAgentId}` })
  }
  const duplicateSkillId = duplicate(configuration.skills.map((skill) => skill.id))
  if (duplicateSkillId) {
    context.addIssue({ code: 'custom', path: ['skills'], message: `Duplicate skill id: ${duplicateSkillId}` })
  }
  const duplicateToolId = duplicate(configuration.customTools.map((tool) => tool.id))
  if (duplicateToolId) {
    context.addIssue({ code: 'custom', path: ['customTools'], message: `Duplicate tool id: ${duplicateToolId}` })
  }
  const agentIds = new Set(configuration.agents.map((agent) => agent.id))
  for (const [index, skill] of configuration.skills.entries()) {
    if (skill.execution === 'extension') continue
    if (!skill.agentId || !agentIds.has(skill.agentId)) {
      context.addIssue({
        code: 'custom',
        path: ['skills', index, 'agentId'],
        message: `Skill references missing agent: ${skill.agentId}`,
      })
    }
  }
}

/** @deprecated Version-1 configuration accepted only at migration boundaries. */
export const agentConfigurationSchema = legacyAgentConfigurationSchema
export type AgentConfiguration = z.infer<typeof legacyAgentConfigurationSchema>
export type PortableAgentConfigurationV2 = z.infer<typeof portableAgentConfigurationV2Schema>
export type PortableAgentConfiguration = z.infer<typeof portableAgentConfigurationSchema>
export type SupportedAgentConfiguration = AgentConfiguration | PortableAgentConfigurationV2 | PortableAgentConfiguration

export const supportedAgentConfigurationSchema = z.union([
  legacyAgentConfigurationSchema,
  portableAgentConfigurationV2Schema,
  portableAgentConfigurationSchema,
])

export const computeProfileSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().positive(),
  provider: z.enum(['openai-codex', 'openai']),
  modelId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/),
  credentialRef: runtimeIdSchema,
}).strict()

export type ComputeProfile = z.infer<typeof computeProfileSchema>

export const computeProfileMetadataSchema = computeProfileSchema.extend({
  credentialStatus: z.enum(['pending', 'connected', 'authentication_required', 'disconnected']),
  credentialLabel: z.string().trim().min(1).max(300).optional(),
}).strict()

export type ComputeProfileMetadata = z.infer<typeof computeProfileMetadataSchema>

export function migrateAgentConfiguration(configuration: SupportedAgentConfiguration): {
  configuration: PortableAgentConfiguration
  compute: Omit<ComputeProfile, 'revision'> | null
} {
  if (configuration.version === 3) {
    return { configuration: portableAgentConfigurationSchema.parse(configuration), compute: null }
  }
  const agents = configuration.version === 1
    ? configuration.agents.map(({ modelId: _modelId, credentialRef: _credentialRef, ...agent }) => agent)
    : configuration.agents
  const skills = configuration.skills.map((skill) => ({ ...skill, execution: 'llm' as const }))
  const modelId = configuration.version === 1
    ? configuration.agents.find((agent) => agent.modelId)?.modelId
    : undefined
  const credentialRef = configuration.version === 1
    ? configuration.agents.find((agent) => agent.credentialRef)?.credentialRef
    : undefined
  return {
    configuration: portableAgentConfigurationSchema.parse({ ...configuration, version: 3, agents, skills }),
    compute: modelId && credentialRef
      ? { version: 1, provider: 'openai', modelId, credentialRef }
      : null,
  }
}

/** @deprecated Use migrateAgentConfiguration for all supported historical versions. */
export function migrateLegacyAgentConfiguration(configuration: AgentConfiguration): ReturnType<typeof migrateAgentConfiguration> {
  return migrateAgentConfiguration(configuration)
}

export const activityEventSchema = z.object({
  id: runtimeIdSchema,
  sequence: z.number().int().positive(),
  callId: runtimeIdSchema.optional(),
  phase: z.enum(['start', 'progress', 'complete', 'error', 'cancelled']),
  kind: z.enum(['thinking', 'tool', 'output', 'status', 'error']),
  label: z.string().trim().min(1).max(200),
  detail: z.string().trim().min(1).max(2_000).optional(),
  /** Outline bullet this event points at, so the activity sidebar can navigate to it. */
  nodeId: runtimeIdSchema.optional(),
  status: z.enum(['pending', 'running', 'success', 'error', 'cancelled']).optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
}).strict()

export type ActivityEvent = z.infer<typeof activityEventSchema>

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'retry_wait',
  'completed',
  'completed_unplaced',
  'failed',
  'cancelled',
  'interrupted',
])

export type RunStatus = z.infer<typeof runStatusSchema>

export const credentialReferenceSchema = z.object({
  id: runtimeIdSchema,
  provider: z.enum(['openai-codex', 'openai']),
}).strict()

const sourcePropertiesSchema = z.record(z.string().max(100), z.string().max(2_000))
  .refine((properties) => Object.keys(properties).length <= 20, 'Too many source properties')

const runSourceSchema = z.object({
  nodeId: runtimeIdSchema.optional(),
  text: z.string().max(100_000).optional(),
  properties: sourcePropertiesSchema.optional(),
}).strict()
const runTargetSchema = z.object({ parentId: runtimeIdSchema }).strict()

export const runInputSchema = z.object({
  version: z.literal(1),
  runId: runtimeIdSchema,
  executionMode: z.enum(['local', 'server']),
  outlineId: runtimeIdSchema,
  source: runSourceSchema,
  target: runTargetSchema,
  baseRevision: z.number().int().nonnegative(),
  configurationRevision: z.number().int().nonnegative(),
  credentialRef: runtimeIdSchema,
  agent: agentDefinitionSchema,
  skill: z.union([legacySkillDefinitionSchema, llmSkillDefinitionSchema]),
  effectiveToolIds: uniqueToolIdsSchema,
  prompt: z.string().trim().min(1).max(20_000),
  context: z.array(z.string().max(20_000)).max(100),
  customTools: z.array(customToolDefinitionSchema).max(100).optional(),
  outlineSnapshot: z.string().max(500_000).optional(),
  localExtensionSnapshot: localExtensionSnapshotSchema.optional(),
}).strict().superRefine((input, context) => {
  if (input.skill.agentId !== input.agent.id) {
    context.addIssue({ code: 'custom', path: ['skill', 'agentId'], message: 'Skill does not reference the snapshotted agent' })
  }
  const effectiveTools = new Set(input.effectiveToolIds)
  for (const requiredToolId of input.skill.requiredToolIds) {
    if (!effectiveTools.has(requiredToolId)) {
      context.addIssue({
        code: 'custom',
        path: ['effectiveToolIds'],
        message: `Required tool is unavailable: ${requiredToolId}`,
      })
    }
  }
  if (input.executionMode === 'server' && input.localExtensionSnapshot) {
    context.addIssue({
      code: 'custom',
      path: ['localExtensionSnapshot'],
      message: 'Local extension snapshots cannot be sent to the server executor',
    })
  }
})

export type RunInput = z.infer<typeof runInputSchema>

export const extensionSkillContextNodeSchema: z.ZodType<ExtensionSkillContextNode> = z.lazy(() => z.object({
  id: runtimeIdSchema,
  text: z.string().max(MAX_NODE_TEXT_CHARS),
  documentOrder: z.number().int().nonnegative(),
  children: z.array(extensionSkillContextNodeSchema).max(MAX_EXTENSION_CONTEXT_NODES).optional(),
}).strict())

export const extensionSkillContextSnapshotSchema = z.object({
  prompt: z.string().max(20_000),
  invocation: z.object({
    id: runtimeIdSchema,
    text: z.string().max(MAX_NODE_TEXT_CHARS),
    parentId: runtimeIdSchema.optional(),
    documentOrder: z.number().int().nonnegative(),
  }).strict(),
  roots: z.array(extensionSkillContextNodeSchema).max(MAX_EXTENSION_CONTEXT_NODES),
  provenance: z.object({
    ancestorPathIds: z.array(runtimeIdSchema).max(32),
    localParentId: runtimeIdSchema.optional(),
    localBranchRootId: runtimeIdSchema.optional(),
    explicitLinkedRootIds: z.array(runtimeIdSchema).max(MAX_EXTENSION_CONTEXT_NODES),
  }).strict(),
}).strict().superRefine((snapshot, context) => {
  const nodes = new Map<string, ExtensionSkillContextNode>()
  const orders = new Set<number>()
  let characters = snapshot.prompt.length + snapshot.invocation.text.length
  const visit = (entries: readonly ExtensionSkillContextNode[]): void => {
    for (const node of entries) {
      characters += node.text.length
      if (nodes.has(node.id)) context.addIssue({ code: 'custom', path: ['roots'], message: `Context node identifiers must be unique: ${node.id}` })
      nodes.set(node.id, node)
      if (orders.has(node.documentOrder)) context.addIssue({ code: 'custom', path: ['roots'], message: `Context document order must be unique: ${node.documentOrder}` })
      orders.add(node.documentOrder)
      if (node.children) visit(node.children)
    }
  }
  visit(snapshot.roots)
  if (nodes.size > MAX_EXTENSION_CONTEXT_NODES) context.addIssue({ code: 'custom', path: ['roots'], message: `Extension context exceeds ${MAX_EXTENSION_CONTEXT_NODES} nodes` })
  if (characters > MAX_EXTENSION_CONTEXT_CHARS) context.addIssue({ code: 'custom', message: `Extension context exceeds ${MAX_EXTENSION_CONTEXT_CHARS} characters including the prompt` })
  if (nodes.has(snapshot.invocation.id)) context.addIssue({ code: 'custom', path: ['invocation', 'id'], message: 'Invocation subtree must be excluded from the context tree' })
  const provenanceIds = [
    ...snapshot.provenance.ancestorPathIds,
    ...(snapshot.provenance.localParentId ? [snapshot.provenance.localParentId] : []),
    ...(snapshot.provenance.localBranchRootId ? [snapshot.provenance.localBranchRootId] : []),
    ...snapshot.provenance.explicitLinkedRootIds,
  ]
  provenanceIds.forEach((id) => {
    if (!nodes.has(id)) context.addIssue({ code: 'custom', path: ['provenance'], message: `Context provenance references an unknown node: ${id}` })
  })
})

export const extensionSkillPlanAnnotationSchema = z.object({
  nodeId: runtimeIdSchema,
  kind: z.enum(['selected', 'shared', 'excluded', 'information']),
  label: z.string().trim().min(1).max(300),
}).strict()

export const extensionSkillPreparedPlanSchema = z.object({
  selectedNodeIds: z.array(runtimeIdSchema).max(MAX_PREPARED_PLAN_IDS)
    .refine((ids) => new Set(ids).size === ids.length, 'Selected node identifiers must be unique'),
  requestedReferenceIds: z.array(runtimeIdSchema).max(MAX_PREPARED_PLAN_IDS)
    .refine((ids) => new Set(ids).size === ids.length, 'Requested reference identifiers must be unique'),
  annotations: z.array(extensionSkillPlanAnnotationSchema).max(MAX_PREVIEW_ANNOTATIONS),
  data: extensionJsonObjectSchema,
}).strict()

export const extensionSkillAdmittedPlanSchema = extensionSkillPreparedPlanSchema.extend({
  admittedReferenceIds: z.array(runtimeIdSchema).max(MAX_PREPARED_PLAN_IDS)
    .refine((ids) => new Set(ids).size === ids.length, 'Admitted reference identifiers must be unique'),
}).strict()

function contextNodeIds(snapshot: z.infer<typeof extensionSkillContextSnapshotSchema>): Set<string> {
  const ids = new Set<string>()
  const visit = (nodes: readonly ExtensionSkillContextNode[]): void => nodes.forEach((node) => {
    ids.add(node.id)
    if (node.children) visit(node.children)
  })
  visit(snapshot.roots)
  return ids
}

export function admitExtensionSkillPreparedPlan(
  value: unknown,
  contextSnapshot: unknown,
  hostAdmittedReferenceIds: Iterable<string>,
): z.infer<typeof extensionSkillAdmittedPlanSchema> {
  const snapshot = extensionSkillContextSnapshotSchema.parse(contextSnapshot)
  const plan = extensionSkillPreparedPlanSchema.parse(value)
  const available = contextNodeIds(snapshot)
  const validateId = (id: string, label: string): void => {
    if (!available.has(id)) throw new Error(`${label} references a node outside the host context snapshot: ${id}`)
  }
  plan.selectedNodeIds.forEach((id) => validateId(id, 'Prepared selection'))
  plan.requestedReferenceIds.forEach((id) => validateId(id, 'Prepared reference request'))
  plan.annotations.forEach(({ nodeId }) => validateId(nodeId, 'Preview annotation'))
  const hostAllowed = new Set(hostAdmittedReferenceIds)
  const unauthorized = plan.requestedReferenceIds.find((id) => !hostAllowed.has(id))
  if (unauthorized) throw new Error(`Prepared plan requested a reference not admitted by the host: ${unauthorized}`)
  return extensionSkillAdmittedPlanSchema.parse({ ...plan, admittedReferenceIds: [...plan.requestedReferenceIds] })
}

export const localExtensionExecutorAuthoritySchema = z.object({
  type: z.literal('local-extension-executor'),
  executor: extensionSkillExecutorReferenceSchema,
}).strict()

export const extensionSkillRunInputSchema = z.object({
  version: z.literal(2),
  execution: z.literal('extension'),
  runId: runtimeIdSchema,
  executionMode: z.literal('local'),
  outlineId: runtimeIdSchema,
  source: runSourceSchema,
  target: runTargetSchema,
  baseRevision: z.number().int().nonnegative(),
  configurationRevision: z.number().int().nonnegative(),
  authority: localExtensionExecutorAuthoritySchema,
  localExecutorSnapshot: localExtensionExecutorSnapshotSchema,
  skill: extensionSkillDefinitionSchema,
  context: extensionSkillContextSnapshotSchema,
  plan: extensionSkillAdmittedPlanSchema,
}).strict().superRefine((input, context) => {
  if (input.authority.executor.extensionId !== input.skill.executor.extensionId
    || input.authority.executor.executorId !== input.skill.executor.executorId) {
    context.addIssue({ code: 'custom', path: ['authority'], message: 'Executor authority does not match the snapshotted extension skill' })
  }
  if (input.localExecutorSnapshot.source.extensionId !== input.authority.executor.extensionId
    || input.localExecutorSnapshot.source.executorId !== input.authority.executor.executorId) {
    context.addIssue({ code: 'custom', path: ['localExecutorSnapshot'], message: 'Local executor snapshot does not match the admitted executor authority' })
  }
  const available = contextNodeIds(input.context)
  for (const id of [...input.plan.selectedNodeIds, ...input.plan.requestedReferenceIds, ...input.plan.admittedReferenceIds]) {
    if (!available.has(id)) context.addIssue({ code: 'custom', path: ['plan'], message: `Pinned plan references a node outside its context: ${id}` })
  }
  const requested = new Set(input.plan.requestedReferenceIds)
  if (input.plan.admittedReferenceIds.some((id) => !requested.has(id))) {
    context.addIssue({ code: 'custom', path: ['plan', 'admittedReferenceIds'], message: 'Host-admitted references must have been requested by the prepared plan' })
  }
})

export const runSnapshotSchema = z.union([runInputSchema, extensionSkillRunInputSchema])
export type LocalExtensionExecutorAuthority = z.infer<typeof localExtensionExecutorAuthoritySchema>
export type ExtensionSkillRunInput = z.infer<typeof extensionSkillRunInputSchema>
export type RunSnapshot = z.infer<typeof runSnapshotSchema>

const sourceReferenceSchema = z.object({
  url: z.url().max(2_000),
  label: z.string().trim().min(1).max(300),
}).strict()

export type StructuredResultV1Node =
  | { type: 'text'; text: string; children?: StructuredResultNode[] }
  | { type: 'image'; assetId: string; alt: string }

/** @deprecated Alias retained for existing version-1 result producers. */
export type StructuredResultNode = StructuredResultV1Node

const structuredResultV1NodeSchema: z.ZodType<StructuredResultV1Node> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().trim().min(1).max(MAX_NODE_TEXT_CHARS),
    children: z.array(structuredResultV1NodeSchema).max(MAX_NODE_COUNT, 'Structured result exceeds maximum node count').optional(),
  }).strict(),
  z.object({
    type: z.literal('image'),
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    alt: z.string().trim().min(1).max(500),
  }).strict(),
]))

export const structuredResultV1Schema = z.object({
  version: z.literal(1),
  nodes: z.array(structuredResultV1NodeSchema).min(1).max(MAX_NODE_COUNT, 'Structured result exceeds maximum node count'),
  sources: z.array(sourceReferenceSchema).max(100),
}).strict()

export const structuredResultInlineSegmentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().min(1).max(MAX_NODE_TEXT_CHARS),
  }).strict(),
  z.object({
    type: z.literal('internal-reference'),
    nodeId: runtimeIdSchema,
    label: z.string().trim().min(1).max(500),
  }).strict(),
])

export type StructuredResultV2Node =
  {
    type: 'text'
    segments: Array<z.infer<typeof structuredResultInlineSegmentSchema>>
    children?: StructuredResultV2Node[]
  }

const structuredResultV2NodeSchema: z.ZodType<StructuredResultV2Node> = z.lazy(() => z.object({
  type: z.literal('text'),
  segments: z.array(structuredResultInlineSegmentSchema).min(1).max(200),
  children: z.array(structuredResultV2NodeSchema).max(MAX_NODE_COUNT, 'Structured result exceeds maximum node count').optional(),
}).strict().superRefine((node, context) => {
  const visibleTextLength = node.segments.reduce((length, segment) => (
    length + (segment.type === 'text' ? segment.text.length : segment.label.length)
  ), 0)
  if (visibleTextLength > MAX_NODE_TEXT_CHARS) {
    context.addIssue({ code: 'custom', path: ['segments'], message: `Text node exceeds ${MAX_NODE_TEXT_CHARS} visible characters` })
  }
}))

export const structuredResultV2Schema = z.object({
  version: z.literal(2),
  nodes: z.array(structuredResultV2NodeSchema).min(1).max(MAX_NODE_COUNT, 'Structured result exceeds maximum node count'),
  sources: z.array(sourceReferenceSchema).max(100),
}).strict()

export const structuredResultSchema = z.union([structuredResultV1Schema, structuredResultV2Schema])

export type StructuredResultV1 = z.infer<typeof structuredResultV1Schema>
export type StructuredResultV2 = z.infer<typeof structuredResultV2Schema>
export type StructuredResult = z.infer<typeof structuredResultSchema>

function measureNodes(
  nodes: StructuredResultV1Node[] | StructuredResultV2Node[],
  depth: number,
): { count: number; text: number; depth: number; segments: number } {
  let count = 0
  let text = 0
  let deepest = depth
  let segments = 0
  for (const node of nodes) {
    count += 1
    if (node.type === 'text') {
      if ('text' in node) text += node.text.length
      else {
        segments += node.segments.length
        text += node.segments.reduce((length, segment) => (
          length + (segment.type === 'text' ? segment.text.length : segment.label.length)
        ), 0)
      }
      if (node.children?.length) {
        const childMeasurement = measureNodes(
          node.children as StructuredResultV1Node[] | StructuredResultV2Node[],
          depth + 1,
        )
        count += childMeasurement.count
        text += childMeasurement.text
        segments += childMeasurement.segments
        deepest = Math.max(deepest, childMeasurement.depth)
      }
    }
  }
  return { count, text, depth: deepest, segments }
}

export interface StructuredResultParseOptions {
  /** Host-admitted reference IDs. Omit only when reading an already admitted historical result. */
  allowedReferenceIds?: Iterable<string>
}

export function parseStructuredResult(
  value: unknown,
  options: StructuredResultParseOptions = {},
): StructuredResult {
  const result = structuredResultSchema.parse(value)
  if (result.version === 2 && options.allowedReferenceIds) {
    const allowed = new Set(options.allowedReferenceIds)
    const visit = (nodes: StructuredResultV2Node[]): void => nodes.forEach((node) => {
      const unknown = node.segments.find((segment) => segment.type === 'internal-reference' && !allowed.has(segment.nodeId))
      if (unknown?.type === 'internal-reference') throw new Error(`Structured result contains an unadmitted reference: ${unknown.nodeId}`)
      if (node.children) visit(node.children)
    })
    visit(result.nodes)
  }
  const measurement = measureNodes(result.nodes, 1)
  if (measurement.depth > MAX_NODE_DEPTH) throw new Error(`Structured result exceeds maximum depth of ${MAX_NODE_DEPTH}`)
  if (measurement.count > MAX_NODE_COUNT) throw new Error(`Structured result exceeds maximum node count of ${MAX_NODE_COUNT}`)
  if (measurement.text > MAX_RESULT_TEXT_CHARS) throw new Error(`Structured result exceeds maximum text size of ${MAX_RESULT_TEXT_CHARS}`)
  if (measurement.segments > MAX_RESULT_SEGMENTS) throw new Error(`Structured result exceeds maximum segment count of ${MAX_RESULT_SEGMENTS}`)
  return result
}

export function requireStructuredResultV1(result: StructuredResult): StructuredResultV1 {
  if (result.version !== 1) {
    throw new Error(`Structured result version ${result.version} requires reference-aware materialization`)
  }
  return result
}

const SECRET_KEY = /(?:^|_)(?:api_?key|access_?token|refresh_?token|password|authorization|secret)(?:$|_)/i

function assertSecretFree(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFree(entry, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) throw new Error(`Run snapshot contains a secret field at ${path}.${key}`)
    assertSecretFree(entry, `${path}.${key}`)
  }
}

export function parseRunSnapshot(serialized: string): RunSnapshot {
  if (serialized.length > 500_000) throw new Error('Run snapshot is too large')
  const value: unknown = JSON.parse(serialized)
  assertSecretFree(value)
  return runSnapshotSchema.parse(value)
}

export const untrustedSourceMaterialSchema = z.object({
  trust: z.literal('untrusted'),
  sourceType: z.enum(['webpage', 'x_post', 'youtube_transcript']),
  canonicalUrl: z.url().max(2_000),
  content: z.string().max(100_000),
  metadata: z.record(z.string().max(100), z.string().max(2_000)).optional(),
}).strict()

export type UntrustedSourceMaterial = z.infer<typeof untrustedSourceMaterialSchema>
