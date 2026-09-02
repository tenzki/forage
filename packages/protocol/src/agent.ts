import { z } from 'zod'
import {
  activityEventSchema,
  agentConfigurationSchema,
  runStatusSchema,
} from '@forage/agent-runtime'

const boundedId = z.string().trim().min(1).max(128)
const revision = z.number().int().nonnegative()
const timestamp = z.iso.datetime({ offset: true })
const uniqueIds = (maximum: number) => z.array(boundedId).max(maximum)
  .refine((ids) => new Set(ids).size === ids.length, 'Identifiers must be unique')

export const agentConfigurationPublishRequestSchema = z.object({
  baseRevision: revision,
  configuration: agentConfigurationSchema,
}).strict().refine(
  ({ baseRevision, configuration }) => configuration.revision === baseRevision + 1,
  { path: ['configuration', 'revision'], message: 'Published configuration revision must advance baseRevision by one' },
)

export const agentConfigurationResponseSchema = z.object({
  configuration: agentConfigurationSchema,
  publishedAt: timestamp,
}).strict()

const matchSchema = z.object({
  sourceKinds: uniqueIds(20).optional(),
  urlTypes: z.array(z.enum(['youtube', 'x', 'webpage'])).max(3)
    .refine((types) => new Set(types).size === types.length, 'URL types must be unique')
    .optional(),
  urlHosts: z.array(z.string().trim().toLowerCase().min(1).max(253)).max(20)
    .refine((hosts) => new Set(hosts).size === hosts.length, 'URL hosts must be unique')
    .optional(),
  sourceEquals: z.record(z.string().max(100), z.string().max(2_000))
    .refine((entries) => Object.keys(entries).length <= 20, 'Too many source equality predicates')
    .optional(),
}).strict().refine((match) => Object.values(match).some((value) => value !== undefined), 'At least one match predicate is required')

export const automationPolicySchema = z.object({
  id: boundedId,
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  priority: z.number().int().min(-10_000).max(10_000),
  match: matchSchema,
  skillIds: uniqueIds(20).min(1),
  dispatcher: z.object({
    enabled: z.boolean(),
    agentId: boundedId.optional(),
    allowedSkillIds: uniqueIds(20),
  }).strict(),
}).strict().superRefine((policy, context) => {
  if (policy.dispatcher.enabled && !policy.dispatcher.agentId) {
    context.addIssue({ code: 'custom', path: ['dispatcher', 'agentId'], message: 'Enabled dispatcher requires an agent identifier' })
  }
  const configured = new Set(policy.skillIds)
  for (const [index, skillId] of policy.dispatcher.allowedSkillIds.entries()) {
    if (!configured.has(skillId)) {
      context.addIssue({
        code: 'custom',
        path: ['dispatcher', 'allowedSkillIds', index],
        message: 'Dispatcher skills must be configured policy skills',
      })
    }
  }
})

export const automationPolicySetSchema = z.object({
  version: z.literal(1),
  revision,
  enabled: z.boolean(),
  policies: z.array(automationPolicySchema).max(100),
}).strict().superRefine((set, context) => {
  const ids = set.policies.map((policy) => policy.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['policies'], message: 'Policy identifiers must be unique' })
  }
})

export type AutomationPolicySet = z.infer<typeof automationPolicySetSchema>

export const automationPolicyPublishRequestSchema = z.object({
  baseRevision: revision,
  policies: automationPolicySetSchema,
}).strict().refine(
  ({ baseRevision, policies }) => policies.revision === baseRevision + 1,
  { path: ['policies', 'revision'], message: 'Published policy revision must advance baseRevision by one' },
)

export const credentialMetadataSchema = z.object({
  id: boundedId,
  provider: z.enum(['openai-codex', 'openai']),
  status: z.enum(['pending', 'connected', 'authentication_required', 'disconnected']),
  accountLabel: z.string().trim().min(1).max(300).optional(),
  expiresAt: timestamp.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

export type CredentialMetadata = z.infer<typeof credentialMetadataSchema>

export const apiKeyEnrollmentRequestSchema = z.object({
  provider: z.literal('openai'),
  apiKey: z.string().trim().min(20).max(512),
}).strict()

export const deviceAuthorizationStartResponseSchema = z.object({
  authorizationId: boundedId,
  verificationUri: z.url().max(2_000),
  userCode: z.string().trim().min(4).max(64),
  expiresAt: timestamp,
  pollIntervalSeconds: z.number().int().min(1).max(60),
}).strict()

export const deviceAuthorizationStatusSchema = z.object({
  authorizationId: boundedId,
  state: z.enum(['pending', 'connected', 'expired', 'denied', 'failed']),
  credential: credentialMetadataSchema.optional(),
}).strict().superRefine((status, context) => {
  if (status.state === 'connected' && !status.credential) {
    context.addIssue({ code: 'custom', path: ['credential'], message: 'Connected authorization requires credential metadata' })
  }
})

export const agentRunAdmissionRequestSchema = z.object({
  sourceNodeId: boundedId,
  targetParentId: boundedId,
  skillId: boundedId,
  prompt: z.string().trim().min(1).max(20_000),
  configurationRevision: revision,
  credentialRef: boundedId.optional(),
}).strict()

export const agentRunAdmissionResponseSchema = z.object({
  runId: boundedId,
  status: z.literal('queued'),
  admittedAt: timestamp,
}).strict()

export const agentRunErrorSchema = z.object({
  code: z.enum([
    'authentication_required',
    'dependency_unavailable',
    'provider_rate_limited',
    'timeout',
    'unsupported_tool',
    'invalid_input',
    'invalid_output',
    'target_unavailable',
    'attempts_exhausted',
    'lease_lost',
  ]),
  message: z.string().trim().min(1).max(1_000),
  retryable: z.boolean(),
}).strict()

const agentRunResultSchema = z.object({
  firstRevision: revision,
  lastRevision: revision,
  rootNoteIds: z.array(boundedId).min(1).max(500),
}).strict().refine((result) => result.lastRevision >= result.firstRevision, 'Result revision range is invalid')

export const agentRunSummarySchema = z.object({
  id: boundedId,
  outlineId: boundedId,
  trigger: z.enum(['manual', 'inbox_automation']),
  status: runStatusSchema,
  skillId: boundedId,
  policyId: boundedId.nullable(),
  configurationRevision: revision,
  attemptCount: z.number().int().nonnegative().max(100),
  admittedAt: timestamp,
  updatedAt: timestamp,
  retryOfRunId: boundedId.nullable(),
}).strict()

export const agentRunDetailSchema = agentRunSummarySchema.extend({
  error: agentRunErrorSchema.nullable(),
  result: agentRunResultSchema.nullable(),
}).strict()

export const agentRunListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: runStatusSchema.optional(),
}).strict()

export const agentRunListResponseSchema = z.object({
  runs: z.array(agentRunSummarySchema).max(100),
  nextCursor: z.string().max(512).nullable(),
}).strict()

export const agentActivityQuerySchema = z.object({
  afterSequence: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict()

export const agentActivityPageSchema = z.object({
  events: z.array(activityEventSchema).max(200),
  nextCursor: z.string().max(512).nullable(),
  status: runStatusSchema,
}).strict().superRefine((page, context) => {
  for (let index = 1; index < page.events.length; index += 1) {
    if (page.events[index]!.sequence <= page.events[index - 1]!.sequence) {
      context.addIssue({ code: 'custom', path: ['events', index, 'sequence'], message: 'Activity sequence must be strictly increasing' })
    }
  }
})

export const agentRunCancelResponseSchema = z.object({
  runId: boundedId,
  status: z.enum(['queued', 'running', 'cancelled', 'completed', 'failed']),
}).strict()

export const agentRunRetryResponseSchema = z.object({
  runId: boundedId,
  retryOfRunId: boundedId,
  status: z.literal('queued'),
}).strict()
