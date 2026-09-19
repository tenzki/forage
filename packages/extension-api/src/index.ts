export const FORAGE_EXTENSION_MANIFEST_VERSION = 1 as const
export const FORAGE_EXTENSION_API_VERSION = '1' as const
export const FORAGE_EXTENSION_MANIFEST_SCHEMA = 'https://forage.app/schemas/extension-manifest-v1.json' as const

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
  | {
    readonly type: 'number'
    readonly minimum?: number
    readonly maximum?: number
    readonly default?: number
  }
  | { readonly type: 'boolean'; readonly default?: boolean }
  | {
    readonly type: 'select'
    readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>
    readonly default?: string
  }
  | { readonly type: 'secret' }
)

export interface ExtensionManifest {
  readonly $schema?: typeof FORAGE_EXTENSION_MANIFEST_SCHEMA
  readonly manifestVersion: typeof FORAGE_EXTENSION_MANIFEST_VERSION
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string
  readonly entry: string
  readonly apiVersion: typeof FORAGE_EXTENSION_API_VERSION
  readonly contributes: {
    readonly tools: ReadonlyArray<ExtensionToolContribution>
    readonly hooks: ReadonlyArray<ExtensionHookName>
    readonly settings: ReadonlyArray<ExtensionSettingDeclaration>
  }
}

export type ExtensionJsonValue = null | boolean | number | string | ExtensionJsonValue[] | {
  [key: string]: ExtensionJsonValue
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

export interface ExtensionToolExecutionContext {
  readonly signal: AbortSignal
  readonly settings: Readonly<Record<string, ExtensionSettingValue>>
  readonly secrets: Readonly<Record<string, string | undefined>>
  reportProgress(progress: ExtensionProgress): void
  log(entry: ExtensionLogEntry): void
}

export interface ExtensionToolDefinition {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly inputSchema: ExtensionToolInputSchema
  execute(input: unknown, context: ExtensionToolExecutionContext): Promise<ExtensionToolResult>
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
  on(event: 'run:start', listener: (context: ExtensionRunContext) => void | Promise<void>): void
  on(event: 'run:end', listener: (context: ExtensionRunEndContext) => void | Promise<void>): void
}

export type ForageExtensionSetup = (host: ForageExtensionHost) => void | Promise<void>

/**
 * Declares a Forage extension entry point while preserving its inferred setup type.
 * Runtime validation and admission remain the responsibility of the Forage host.
 */
export function defineExtension<T extends ForageExtensionSetup>(setup: T): T {
  return setup
}
