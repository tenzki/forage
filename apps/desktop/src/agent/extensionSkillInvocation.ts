import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type {
  ExtensionCatalog,
  ExtensionConfiguration,
  ExtensionLogEntry,
  ExtensionProgress,
  ExtensionSkillDefinition,
  RunSnapshot,
  StructuredResult,
  StructuredResultV2,
} from '@forage/agent-runtime'
import { parseStructuredResult, runSnapshotSchema } from '@forage/agent-runtime'
import type { LocalAgentRun } from '../persistence/eventStore'
import { resolveExtensionSkillContext, type ResolvedExtensionSkillContext } from './context'
import {
  extensionExecutorBridge,
  type ExtensionExecutorBridge,
  type PreparedExtensionExecutorAdmission,
} from './extensionExecutorClient'
import { extensionExecutorOptions, type ExtensionExecutorOption } from '../store/extensionStore'

export interface PreparedExtensionSkillInvocation {
  option: ExtensionExecutorOption
  skill: ExtensionSkillDefinition
  context: ResolvedExtensionSkillContext
  admission: PreparedExtensionExecutorAdmission
}

export interface RetainedExtensionRunRepository {
  admitAgentRun(run: LocalAgentRun): Promise<void>
  beginAgentAttempt(runId: string, startedAt: string): Promise<number>
  settleAgentRun(
    runId: string,
    status: 'completed_unplaced' | 'failed' | 'cancelled',
    resultIdentity: string | null,
    result: StructuredResult | null,
    errorCode: string | null,
    settledAt: string,
  ): Promise<void>
}

export function selectedExtensionExecutor(
  skill: ExtensionSkillDefinition,
  catalog: ExtensionCatalog | null,
): ExtensionExecutorOption {
  const option = extensionExecutorOptions(catalog).find((candidate) => (
    candidate.extensionId === skill.executor.extensionId && candidate.executorId === skill.executor.executorId
  ))
  if (!option) throw new Error(`The extension executor ${skill.executor.extensionId}/${skill.executor.executorId} is not installed.`)
  if (!option.available) throw new Error(option.unavailableReason ?? `The extension executor ${option.name} is unavailable.`)
  return option
}

export function assertExtensionExecutionLocation(mode: 'local' | 'server'): void {
  if (mode === 'server') {
    throw new Error('This skill uses a device-local extension executor and cannot run in server mode. No desktop fallback was attempted.')
  }
}

export async function prepareExtensionSkillInvocation(input: {
  skill: ExtensionSkillDefinition
  prompt: string
  doc: ProseMirrorNode
  invocationNodeId: string
  catalog: ExtensionCatalog | null
  localConfiguration: ExtensionConfiguration | null
  portableConfigurationRevision: number
  runId: string
  bridge?: ExtensionExecutorBridge
  signal?: AbortSignal
}): Promise<PreparedExtensionSkillInvocation> {
  const option = selectedExtensionExecutor(input.skill, input.catalog)
  if (!input.prompt.trim() && !option.allowEmptyPrompt) {
    throw new Error(`/${input.skill.label} requires an invocation prompt.`)
  }
  if (!input.catalog || !input.localConfiguration) {
    throw new Error('Local extension inventory is unavailable; open Extensions settings and retry.')
  }
  const context = resolveExtensionSkillContext(input.doc, input.invocationNodeId, input.prompt)
  const admission = await (input.bridge ?? extensionExecutorBridge()).admit({
    catalog: input.catalog,
    localConfiguration: input.localConfiguration,
    portableConfigurationRevision: input.portableConfigurationRevision,
    executor: input.skill.executor,
    runId: input.runId,
    configuration: input.skill.configuration,
    context: context.snapshot,
    hostAdmittedReferenceIds: context.admittedReferenceIds,
  }, { signal: input.signal })
  return { option, skill: structuredClone(input.skill), context, admission }
}

export async function executePreparedExtensionSkill(
  prepared: PreparedExtensionSkillInvocation,
  options: {
    secrets?: Readonly<Record<string, string | undefined>>
    signal?: AbortSignal
    onProgress?: (progress: ExtensionProgress) => void
    onLog?: (entry: ExtensionLogEntry) => void
  },
): Promise<StructuredResultV2> {
  const result = await prepared.admission.execute(options.secrets, {
    signal: options.signal,
    onProgress: options.onProgress,
    onLog: options.onLog,
  })
  const parsed = parseStructuredResult({
    version: 2,
    nodes: result.nodes,
    sources: result.sources ?? [],
  }, { allowedReferenceIds: prepared.admission.plan.admittedReferenceIds })
  if (parsed.version !== 2) throw new Error('Extension executor returned an unsupported result version.')
  return parsed
}

export function extensionRunSnapshot(
  prepared: PreparedExtensionSkillInvocation,
  runId: string,
  outlineId: string,
  invocationNodeId: string,
): RunSnapshot {
  if (prepared.context.snapshot.invocation.id !== invocationNodeId
    || prepared.admission.context.invocation.id !== invocationNodeId) {
    throw new Error('The retained extension run target does not match its admitted invocation.')
  }
  return runSnapshotSchema.parse({
    version: 2,
    execution: 'extension',
    runId,
    executionMode: 'local',
    outlineId,
    source: { nodeId: invocationNodeId, text: prepared.context.snapshot.prompt },
    target: { parentId: invocationNodeId },
    baseRevision: 0,
    configurationRevision: prepared.admission.portableConfigurationRevision,
    authority: { type: 'local-extension-executor', executor: prepared.skill.executor },
    localExecutorSnapshot: prepared.admission.executorSnapshot,
    skill: prepared.skill,
    context: prepared.admission.context,
    plan: prepared.admission.plan,
  })
}

export async function retainPreparedExtensionSkillResult(
  prepared: PreparedExtensionSkillInvocation,
  input: {
    repository: RetainedExtensionRunRepository
    runId: string
    outlineId: string
    invocationNodeId: string
    secrets?: Readonly<Record<string, string | undefined>>
    signal?: AbortSignal
    onProgress?: (progress: ExtensionProgress) => void
    onLog?: (entry: ExtensionLogEntry) => void
    now?: () => string
  },
): Promise<StructuredResultV2> {
  const now = input.now ?? (() => new Date().toISOString())
  const snapshot = extensionRunSnapshot(prepared, input.runId, input.outlineId, input.invocationNodeId)
  const createdAt = now()
  const run: LocalAgentRun = {
    id: input.runId,
    outlineId: input.outlineId,
    snapshot,
    status: 'queued',
    attemptCount: 0,
    resultIdentity: null,
    result: null,
    retryOfRunId: null,
    cancelRequestedAt: null,
    errorCode: null,
    createdAt,
    updatedAt: createdAt,
  }
  await input.repository.admitAgentRun(run)
  await input.repository.beginAgentAttempt(input.runId, now())
  try {
    const result = await executePreparedExtensionSkill(prepared, input)
    await input.repository.settleAgentRun(
      input.runId,
      'completed_unplaced',
      `result:${input.runId}`,
      result,
      null,
      now(),
    )
    return result
  } catch (error) {
    const cancelled = input.signal?.aborted
      || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
    await input.repository.settleAgentRun(
      input.runId,
      cancelled ? 'cancelled' : 'failed',
      null,
      null,
      cancelled ? null : 'execution_failed',
      now(),
    )
    throw error
  }
}
