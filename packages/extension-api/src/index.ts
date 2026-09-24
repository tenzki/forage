export interface ExtensionToolContribution {
  readonly id: string
  readonly name: string
  readonly description: string
}

export type ExtensionHookName = 'run:start' | 'run:end'

interface ExtensionSettingBase {
  readonly key: string
  readonly label: string
  readonly description?: string
  readonly required?: boolean
}

export type ExtensionSettingDeclaration = ExtensionSettingBase & (
  | { readonly type: 'string'; readonly default?: string }
  | { readonly type: 'multiline'; readonly default?: string }
  | { readonly type: 'number'; readonly minimum?: number; readonly maximum?: number; readonly default?: number }
  | { readonly type: 'boolean'; readonly default?: boolean }
  | {
    readonly type: 'select'
    readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>
    readonly default?: string
  }
  | { readonly type: 'secret' }
)

export type ExtensionJsonPrimitive = null | boolean | number | string
export type ExtensionJsonValue = ExtensionJsonPrimitive | ExtensionJsonValue[] | {
  [key: string]: ExtensionJsonValue
}
export type ExtensionJsonObject = { [key: string]: ExtensionJsonValue }

interface ExtensionSkillFieldBase {
  readonly key: string
  readonly label: string
  readonly description?: string
  readonly required?: boolean
}

export type ExtensionSkillConfigurationField = ExtensionSkillFieldBase & (
  | { readonly type: 'text' | 'multiline'; readonly default?: string; readonly minLength?: number; readonly maxLength?: number }
  | { readonly type: 'number'; readonly default?: number; readonly minimum?: number; readonly maximum?: number; readonly integer?: boolean }
  | { readonly type: 'boolean'; readonly default?: boolean }
  | {
    readonly type: 'choice'
    readonly options: ReadonlyArray<{ readonly value: string; readonly label: string; readonly description?: string }>
    readonly default?: string
  }
  | { readonly type: 'object'; readonly fields: ReadonlyArray<ExtensionSkillConfigurationField> }
  | {
    readonly type: 'repeat'
    readonly minimumItems?: number
    readonly maximumItems: number
    readonly fields: ReadonlyArray<ExtensionSkillConfigurationField>
  }
)

export interface ExtensionSkillConfigurationCondition {
  readonly field: string
  readonly equals: string | number | boolean | null
}

export interface ExtensionSkillConfigurationBranch {
  readonly when: ExtensionSkillConfigurationCondition
  readonly fields: ReadonlyArray<ExtensionSkillConfigurationField>
}

export interface ExtensionSkillConfigurationForm {
  readonly fields: ReadonlyArray<ExtensionSkillConfigurationField>
  readonly branches?: ReadonlyArray<ExtensionSkillConfigurationBranch>
}

export interface ExtensionSkillExecutorContribution {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly allowEmptyPrompt?: boolean
  readonly configuration: ExtensionSkillConfigurationForm
}

export interface ExtensionManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string
  readonly entry: string
  readonly contributes: {
    readonly tools: ReadonlyArray<ExtensionToolContribution>
    readonly hooks: ReadonlyArray<ExtensionHookName>
    readonly settings: ReadonlyArray<ExtensionSettingDeclaration>
    readonly executors?: ReadonlyArray<ExtensionSkillExecutorContribution>
  }
}

export type ExtensionToolInputSchema = Readonly<Record<string, ExtensionJsonValue>>
export type ExtensionToolResult = { text: string } | { json: ExtensionJsonValue }

export interface ExtensionProgress {
  readonly message: string
  readonly completed?: number
  readonly total?: number
}

export interface ExtensionLogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly data?: ExtensionJsonValue
}

export type ExtensionSettingValue = string | number | boolean

interface ExtensionOperationContext {
  readonly signal: AbortSignal
  readonly settings: Readonly<Record<string, ExtensionSettingValue>>
  log(entry: ExtensionLogEntry): void
}

export interface ExtensionToolExecutionContext extends ExtensionOperationContext {
  readonly secrets: Readonly<Record<string, string | undefined>>
  reportProgress(progress: ExtensionProgress): void
}

export interface ExtensionToolDefinition {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly inputSchema: ExtensionToolInputSchema
  execute(input: unknown, context: ExtensionToolExecutionContext): Promise<ExtensionToolResult>
}

export interface ExtensionSkillContextNode {
  readonly id: string
  readonly text: string
  readonly documentOrder: number
  readonly children?: ReadonlyArray<ExtensionSkillContextNode>
}

export interface ExtensionSkillContextSnapshot {
  readonly prompt: string
  readonly invocation: {
    readonly id: string
    readonly text: string
    readonly parentId?: string
    readonly documentOrder: number
  }
  readonly roots: ReadonlyArray<ExtensionSkillContextNode>
  readonly provenance: {
    readonly ancestorPathIds: ReadonlyArray<string>
    readonly localParentId?: string
    readonly localBranchRootId?: string
    readonly explicitLinkedRootIds: ReadonlyArray<string>
  }
}

export interface ExtensionSkillConfigurationIssue {
  readonly path: ReadonlyArray<string | number>
  readonly message: string
}

export type ExtensionSkillConfigurationValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: ReadonlyArray<ExtensionSkillConfigurationIssue> }

export interface ExtensionSkillPlanAnnotation {
  readonly nodeId: string
  readonly kind: 'selected' | 'shared' | 'excluded' | 'information'
  readonly label: string
}

/** Returned by extension code. IDs are requests which still require host admission. */
export interface ExtensionSkillPreparedPlan {
  readonly selectedNodeIds: ReadonlyArray<string>
  readonly requestedReferenceIds: ReadonlyArray<string>
  readonly annotations: ReadonlyArray<ExtensionSkillPlanAnnotation>
  readonly data: ExtensionJsonObject
}

/** Constructed only by the host after validating the extension's requested IDs. */
export interface ExtensionSkillAdmittedPlan extends ExtensionSkillPreparedPlan {
  readonly admittedReferenceIds: ReadonlyArray<string>
}

export interface ExtensionSkillValidationInput {
  readonly configuration: ExtensionJsonObject
}

export interface ExtensionSkillPreparationInput {
  readonly runId: string
  readonly configuration: ExtensionJsonObject
  readonly context: ExtensionSkillContextSnapshot
}

export type ExtensionSkillResultSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'internal-reference'; readonly nodeId: string; readonly label: string }

export interface ExtensionSkillResultNode {
  readonly type: 'text'
  readonly segments: ReadonlyArray<ExtensionSkillResultSegment>
  readonly note?: string
  readonly children?: ReadonlyArray<ExtensionSkillResultNode>
}

export interface ExtensionSkillResult {
  /** New bullets placed under the invocation. May be empty only when `reorder` or `tags` is present. */
  readonly nodes: ReadonlyArray<ExtensionSkillResultNode>
  readonly sources?: ReadonlyArray<{ readonly url: string; readonly label: string }>
  /**
   * Admitted sibling bullets in their new order. The host permutes them among the
   * positions they already occupy; other siblings keep their places.
   */
  readonly reorder?: { readonly nodeIds: ReadonlyArray<string> }
  /**
   * Inline `#tag`s (names without `#`) to add to or remove from admitted bullets.
   * The host appends missing tags to the end of the bullet text and deletes removed ones.
   */
  readonly tags?: ReadonlyArray<{
    readonly nodeId: string
    readonly add: ReadonlyArray<string>
    readonly remove?: ReadonlyArray<string>
  }>
}

export interface ExtensionSkillExecutionInput {
  readonly runId: string
  readonly configuration: ExtensionJsonObject
  readonly context: ExtensionSkillContextSnapshot
  readonly plan: ExtensionSkillAdmittedPlan
}

export interface ExtensionSkillValidationContext extends ExtensionOperationContext {}
export interface ExtensionSkillPreparationContext extends ExtensionOperationContext {
  reportProgress(progress: ExtensionProgress): void
}
export interface ExtensionSkillExecutionContext extends ExtensionOperationContext {
  readonly secrets: Readonly<Record<string, string | undefined>>
  reportProgress(progress: ExtensionProgress): void
}

export interface ExtensionSkillExecutorDefinition extends ExtensionSkillExecutorContribution {
  validateConfiguration(
    input: ExtensionSkillValidationInput,
    context: ExtensionSkillValidationContext,
  ): Promise<ExtensionSkillConfigurationValidation>
  prepare(input: ExtensionSkillPreparationInput, context: ExtensionSkillPreparationContext): Promise<ExtensionSkillPreparedPlan>
  execute(input: ExtensionSkillExecutionInput, context: ExtensionSkillExecutionContext): Promise<ExtensionSkillResult>
}

export interface ExtensionRunContext {
  readonly runId: string
  readonly signal: AbortSignal
  readonly settings: Readonly<Record<string, ExtensionSettingValue>>
  readonly secrets: Readonly<Record<string, string | undefined>>
  log(entry: ExtensionLogEntry): void
}

export interface ExtensionRunEndContext extends ExtensionRunContext {
  readonly outcome: 'completed' | 'failed' | 'cancelled'
}

export interface ForageExtensionHost {
  registerTool(tool: ExtensionToolDefinition): void
  registerSkillExecutor(executor: ExtensionSkillExecutorDefinition): void
  on(event: 'run:start', listener: (context: ExtensionRunContext) => void | Promise<void>): void
  on(event: 'run:end', listener: (context: ExtensionRunEndContext) => void | Promise<void>): void
}

export type ForageExtensionSetup = (host: ForageExtensionHost) => void | Promise<void>

export function defineExtension(setup: ForageExtensionSetup): ForageExtensionSetup {
  return setup
}
