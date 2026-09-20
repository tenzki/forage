import {
  admitExtensionSkillPreparedPlan,
  extensionJsonObjectSchema,
  extensionSkillContextSnapshotSchema,
  type ExtensionCatalog,
  type ExtensionConfiguration,
  type ExtensionJsonObject,
  type ExtensionSkillAdmittedPlan,
  type ExtensionSkillContextSnapshot,
  type LocalExtensionExecutorSnapshot,
} from '@forage/agent-runtime'
import type { ExtensionProgress, ExtensionSkillResult } from '@forage/extension-api'
import { acquireManagedRevisionLeases, type ManagedRevisionLease } from './leases'
import {
  NodeExtensionExecutorProcess,
  type ExtensionExecutorOperationOptions,
} from './executor-process'
import type { ExtensionRuntimeLog } from './runtime'
import {
  createLocalExtensionExecutorSnapshot,
  verifyLocalExtensionExecutorSnapshot,
} from './snapshot'

export interface ExtensionExecutorAdmissionInput {
  catalog: ExtensionCatalog
  localConfiguration: ExtensionConfiguration
  configurationRoot: string
  portableConfigurationRevision: number
  executor: { extensionId: string; executorId: string }
  runId: string
  configuration: ExtensionJsonObject
  context: ExtensionSkillContextSnapshot
  hostAdmittedReferenceIds: Iterable<string>
}

export interface ExtensionExecutorAdmissionOptions extends ExtensionExecutorOperationOptions {}

export interface ExtensionExecutorExecutionOptions extends ExtensionExecutorOperationOptions {
  secrets?: Readonly<Record<string, string | undefined>>
}

export class ExtensionExecutorAdmissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues?: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
  ) {
    super(message)
    this.name = 'ExtensionExecutorAdmissionError'
  }
}

export class AdmittedExtensionExecutorRun {
  readonly executorSnapshot: LocalExtensionExecutorSnapshot
  readonly portableConfigurationRevision: number
  readonly configuration: ExtensionJsonObject
  readonly context: ExtensionSkillContextSnapshot
  readonly plan: ExtensionSkillAdmittedPlan
  private released = false
  private executed = false
  private execution: Promise<ExtensionSkillResult> | undefined

  constructor(
    private readonly runner: NodeExtensionExecutorProcess,
    private readonly selection: Parameters<NodeExtensionExecutorProcess['execute']>[0],
    private readonly lease: ManagedRevisionLease,
    values: {
      executorSnapshot: LocalExtensionExecutorSnapshot
      portableConfigurationRevision: number
      configuration: ExtensionJsonObject
      context: ExtensionSkillContextSnapshot
      plan: ExtensionSkillAdmittedPlan
      runId: string
    },
  ) {
    this.executorSnapshot = deepFreeze(structuredClone(values.executorSnapshot))
    this.portableConfigurationRevision = values.portableConfigurationRevision
    this.configuration = deepFreeze(structuredClone(values.configuration))
    this.context = deepFreeze(structuredClone(values.context))
    this.plan = deepFreeze(structuredClone(values.plan))
    this.runId = values.runId
  }

  readonly runId: string

  async execute(options: ExtensionExecutorExecutionOptions): Promise<ExtensionSkillResult> {
    if (this.released) throw new ExtensionExecutorAdmissionError('executor_admission_released', 'The admitted executor revision has been released.')
    if (this.executed) throw new ExtensionExecutorAdmissionError('executor_already_executed', 'The admitted executor plan can be executed only once.')
    this.executed = true
    this.execution = this.runner.execute(this.selection, {
      runId: this.runId,
      configuration: this.configuration,
      context: this.context,
      plan: this.plan,
    }, options.secrets ?? {}, options)
    return this.execution
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    if (this.execution) await this.execution.catch(() => undefined)
    await this.lease.release()
  }
}

export class ExtensionExecutorHost {
  constructor(private readonly runner: NodeExtensionExecutorProcess) {}

  async admit(
    input: ExtensionExecutorAdmissionInput,
    options: ExtensionExecutorAdmissionOptions,
  ): Promise<AdmittedExtensionExecutorRun> {
    const configuration = extensionJsonObjectSchema.parse(input.configuration)
    const context = extensionSkillContextSnapshotSchema.parse(input.context)
    const executorSnapshot = createLocalExtensionExecutorSnapshot(input.catalog, input.localConfiguration, input.executor)
    const entry = verifyLocalExtensionExecutorSnapshot(executorSnapshot, input.catalog, input.localConfiguration)
    const sourceConfiguration = input.localConfiguration.sources.find((source) => (
      source.installationId === executorSnapshot.source.installationId
    ))
    if (!sourceConfiguration) throw new ExtensionExecutorAdmissionError('executor_source_unavailable', 'The selected executor source configuration is unavailable.')
    const selection = { entry, sourceConfiguration, executorId: input.executor.executorId }
    const lease = await acquireManagedRevisionLeases(input.configurationRoot, {
      sources: [executorSnapshot.source],
    }, input.catalog)
    try {
      const validation = await this.runner.validate(selection, { configuration }, options)
      if (!validation.valid) {
        throw new ExtensionExecutorAdmissionError('executor_configuration_invalid', 'Extension executor configuration is invalid.', validation.issues)
      }
      const prepared = await this.runner.prepare(selection, {
        runId: input.runId,
        configuration,
        context,
      }, options)
      const plan = admitExtensionSkillPreparedPlan(prepared, context, input.hostAdmittedReferenceIds)
      return new AdmittedExtensionExecutorRun(this.runner, selection, lease, {
        executorSnapshot,
        portableConfigurationRevision: input.portableConfigurationRevision,
        configuration,
        context,
        plan,
        runId: input.runId,
      })
    } catch (error) {
      await lease.release()
      throw error
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach((entry) => deepFreeze(entry))
  }
  return value
}

export type { ExtensionProgress, ExtensionRuntimeLog }
