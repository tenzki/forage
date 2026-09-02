import { z } from 'zod'

const MAX_AGENT_PROMPT_CHARS = 20_000
const MAX_NODE_DEPTH = 8
const MAX_NODE_COUNT = 500
const MAX_NODE_TEXT_CHARS = 20_000
const MAX_RESULT_TEXT_CHARS = 100_000

export const runtimeIdSchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid identifier')
const definitionIdSchema = z.string().trim().min(1).max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Invalid definition identifier')
const toolIdSchema = z.string().trim().min(1).max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Invalid tool identifier')
const uniqueToolIdsSchema = z.array(toolIdSchema).max(64)
  .refine((ids) => new Set(ids).size === ids.length, 'Tool identifiers must be unique')

export const agentDefinitionSchema = z.object({
  id: definitionIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300),
  systemPrompt: z.string().trim().min(1).max(MAX_AGENT_PROMPT_CHARS),
  modelId: z.string().trim().max(128).refine(
    (value) => !value || /^[A-Za-z0-9._:/-]+$/.test(value),
    'Invalid model identifier',
  ),
  toolIds: uniqueToolIdsSchema,
  credentialRef: runtimeIdSchema.optional(),
}).strict()

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>

export const skillDefinitionSchema = z.object({
  id: definitionIdSchema,
  label: z.string().trim().regex(/^[a-z][a-z0-9-]{1,31}$/),
  description: z.string().trim().min(1).max(300),
  systemPrompt: z.string().trim().min(1).max(MAX_AGENT_PROMPT_CHARS),
  agentId: definitionIdSchema,
  requiredToolIds: uniqueToolIdsSchema,
}).strict()

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

export const agentConfigurationSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  agents: z.array(agentDefinitionSchema).max(100),
  skills: z.array(skillDefinitionSchema).max(200),
  customTools: z.array(customToolDefinitionSchema).max(100),
  globallyEnabledToolIds: uniqueToolIdsSchema,
}).strict().superRefine((configuration, context) => {
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
    if (!agentIds.has(skill.agentId)) {
      context.addIssue({
        code: 'custom',
        path: ['skills', index, 'agentId'],
        message: `Skill references missing agent: ${skill.agentId}`,
      })
    }
  }
})

export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>

export const activityEventSchema = z.object({
  id: runtimeIdSchema,
  sequence: z.number().int().positive(),
  callId: runtimeIdSchema.optional(),
  phase: z.enum(['start', 'progress', 'complete', 'error', 'cancelled']),
  kind: z.enum(['thinking', 'tool', 'output', 'status', 'error']),
  label: z.string().trim().min(1).max(200),
  detail: z.string().trim().min(1).max(2_000).optional(),
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

export const runInputSchema = z.object({
  version: z.literal(1),
  runId: runtimeIdSchema,
  executionMode: z.enum(['local', 'server']),
  outlineId: runtimeIdSchema,
  source: z.object({
    nodeId: runtimeIdSchema.optional(),
    text: z.string().max(100_000).optional(),
    properties: sourcePropertiesSchema.optional(),
  }).strict(),
  target: z.object({ parentId: runtimeIdSchema }).strict(),
  baseRevision: z.number().int().nonnegative(),
  configurationRevision: z.number().int().nonnegative(),
  credentialRef: runtimeIdSchema,
  agent: agentDefinitionSchema,
  skill: skillDefinitionSchema,
  effectiveToolIds: uniqueToolIdsSchema,
  prompt: z.string().trim().min(1).max(20_000),
  context: z.array(z.string().max(20_000)).max(100),
  customTools: z.array(customToolDefinitionSchema).max(100).optional(),
  outlineSnapshot: z.string().max(500_000).optional(),
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
})

export type RunInput = z.infer<typeof runInputSchema>

const sourceReferenceSchema = z.object({
  url: z.url().max(2_000),
  label: z.string().trim().min(1).max(300),
}).strict()

export type StructuredResultNode =
  | { type: 'text'; text: string; children?: StructuredResultNode[] }
  | { type: 'image'; assetId: string; alt: string }

const structuredResultNodeSchema: z.ZodType<StructuredResultNode> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().trim().min(1).max(MAX_NODE_TEXT_CHARS),
    children: z.array(structuredResultNodeSchema).max(MAX_NODE_COUNT, 'Structured result exceeds maximum node count').optional(),
  }).strict(),
  z.object({
    type: z.literal('image'),
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    alt: z.string().trim().min(1).max(500),
  }).strict(),
]))

export const structuredResultSchema = z.object({
  version: z.literal(1),
  nodes: z.array(structuredResultNodeSchema).min(1).max(MAX_NODE_COUNT, 'Structured result exceeds maximum node count'),
  sources: z.array(sourceReferenceSchema).max(100),
}).strict()

export type StructuredResult = z.infer<typeof structuredResultSchema>

function measureNodes(nodes: StructuredResultNode[], depth: number): { count: number; text: number; depth: number } {
  let count = 0
  let text = 0
  let deepest = depth
  for (const node of nodes) {
    count += 1
    if (node.type === 'text') {
      text += node.text.length
      if (node.children?.length) {
        const childMeasurement = measureNodes(node.children, depth + 1)
        count += childMeasurement.count
        text += childMeasurement.text
        deepest = Math.max(deepest, childMeasurement.depth)
      }
    }
  }
  return { count, text, depth: deepest }
}

export function parseStructuredResult(value: unknown): StructuredResult {
  const result = structuredResultSchema.parse(value)
  const measurement = measureNodes(result.nodes, 1)
  if (measurement.depth > MAX_NODE_DEPTH) throw new Error(`Structured result exceeds maximum depth of ${MAX_NODE_DEPTH}`)
  if (measurement.count > MAX_NODE_COUNT) throw new Error(`Structured result exceeds maximum node count of ${MAX_NODE_COUNT}`)
  if (measurement.text > MAX_RESULT_TEXT_CHARS) throw new Error(`Structured result exceeds maximum text size of ${MAX_RESULT_TEXT_CHARS}`)
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

export function parseRunSnapshot(serialized: string): RunInput {
  if (serialized.length > 500_000) throw new Error('Run snapshot is too large')
  const value: unknown = JSON.parse(serialized)
  assertSecretFree(value)
  return runInputSchema.parse(value)
}

export const untrustedSourceMaterialSchema = z.object({
  trust: z.literal('untrusted'),
  sourceType: z.enum(['webpage', 'x_post', 'youtube_transcript']),
  canonicalUrl: z.url().max(2_000),
  content: z.string().max(100_000),
  metadata: z.record(z.string().max(100), z.string().max(2_000)).optional(),
}).strict()

export type UntrustedSourceMaterial = z.infer<typeof untrustedSourceMaterialSchema>
