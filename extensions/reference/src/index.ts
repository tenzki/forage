import {
  defineExtension,
  type ExtensionSkillContextNode,
  type ExtensionSkillExecutorDefinition,
  type ExtensionToolDefinition,
  type ExtensionToolInputSchema,
} from '@forage/extension-api'

export const TEXT_STATS_MAX_LENGTH = 20_000

export const textStatsInputSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: TEXT_STATS_MAX_LENGTH },
  },
  required: ['text'],
  additionalProperties: false,
} as const satisfies ExtensionToolInputSchema

function parseTextStatsInput(input: unknown): { text: string; characters: number } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('text_stats input must be an object')
  }

  const keys = Object.keys(input)
  if (keys.length !== 1 || keys[0] !== 'text') {
    throw new TypeError('text_stats input must contain only text')
  }

  const text = (input as Record<string, unknown>).text
  if (typeof text !== 'string') {
    throw new TypeError('text_stats text must be a string')
  }
  const characters = Array.from(text).length
  if (characters > TEXT_STATS_MAX_LENGTH) {
    throw new RangeError(`text_stats text must not exceed ${TEXT_STATS_MAX_LENGTH} characters`)
  }
  return { text, characters }
}

export const textStatsTool: ExtensionToolDefinition = {
  id: 'text_stats',
  name: 'Text statistics',
  description: 'Count whitespace-delimited words and Unicode characters in text.',
  inputSchema: textStatsInputSchema,
  async execute(input, context) {
    context.signal.throwIfAborted()
    const { text, characters } = parseTextStatsInput(input)
    const progressMessage = typeof context.settings.progress_message === 'string'
      ? context.settings.progress_message
      : 'Counting text'
    context.reportProgress({ message: progressMessage, completed: 0, total: 1 })

    const words = text.match(/\S+/gu)?.length ?? 0
    context.signal.throwIfAborted()
    context.reportProgress({ message: 'Text counted', completed: 1, total: 1 })
    return { json: { words, characters } }
  },
}

function flattenNodes(nodes: ReadonlyArray<ExtensionSkillContextNode>): ExtensionSkillContextNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children ?? [])])
}

export const labelNotesExecutor: ExtensionSkillExecutorDefinition = {
  id: 'label_notes',
  name: 'Label matching notes',
  description: 'Select notes containing configured text and return ordinary linked labels.',
  allowEmptyPrompt: true,
  configuration: {
    fields: [
      { key: 'contains', label: 'Text to match', type: 'text', required: true, minLength: 1, maxLength: 200 },
      { key: 'prefix', label: 'Output prefix', type: 'text', default: 'Match', maxLength: 100 },
      { key: 'include_ids', label: 'Include stable IDs', type: 'boolean', default: false },
    ],
    branches: [{
      when: { field: 'include_ids', equals: true },
      fields: [{
        key: 'id_separator', label: 'ID separator', type: 'choice',
        options: [{ value: 'dash', label: 'Dash' }, { value: 'colon', label: 'Colon' }], default: 'dash',
      }],
    }],
  },
  async validateConfiguration({ configuration }) {
    const contains = configuration.contains
    if (typeof contains !== 'string' || contains.trim().length === 0 || contains.length > 200) {
      return { valid: false, issues: [{ path: ['contains'], message: 'Text to match is required and must not exceed 200 characters.' }] }
    }
    return { valid: true }
  },
  async prepare({ configuration, context }) {
    const contains = String(configuration.contains).toLocaleLowerCase('en-US')
    const selectedNodeIds = flattenNodes(context.roots)
      .filter((node) => node.text.toLocaleLowerCase('en-US').includes(contains))
      .sort((left, right) => left.documentOrder - right.documentOrder)
      .map((node) => node.id)
    return {
      selectedNodeIds,
      requestedReferenceIds: selectedNodeIds,
      annotations: selectedNodeIds.map((nodeId) => ({ nodeId, kind: 'selected', label: 'Matching note' })),
      data: {
        prefix: typeof configuration.prefix === 'string' ? configuration.prefix : 'Match',
        includeIds: configuration.include_ids === true,
        idSeparator: configuration.id_separator === 'colon' ? ': ' : ' - ',
      },
    }
  },
  async execute({ context, plan }, operation) {
    operation.signal.throwIfAborted()
    const byId = new Map(flattenNodes(context.roots).map((node) => [node.id, node]))
    const prefix = typeof plan.data.prefix === 'string' ? plan.data.prefix : 'Match'
    const includeIds = plan.data.includeIds === true
    const idSeparator = plan.data.idSeparator === ': ' ? ': ' : ' - '
    operation.reportProgress({ message: 'Formatting matching notes', completed: 0, total: plan.selectedNodeIds.length })
    return {
      nodes: plan.selectedNodeIds.length > 0
        ? plan.selectedNodeIds.map((nodeId, index) => {
          operation.signal.throwIfAborted()
          operation.reportProgress({ message: 'Formatting matching notes', completed: index + 1, total: plan.selectedNodeIds.length })
          return {
            type: 'text' as const,
            segments: [
              { type: 'text' as const, text: `${prefix}: ${includeIds ? `${nodeId}${idSeparator}` : ''}` },
              { type: 'internal-reference' as const, nodeId, label: byId.get(nodeId)?.text ?? nodeId },
            ],
          }
        })
        : [{ type: 'text', segments: [{ type: 'text', text: 'No matching notes.' }] }],
    }
  },
}

export default defineExtension((forage) => {
  forage.on('run:start', (context) => {
    context.log({ level: 'debug', message: `Text Stats started for ${context.runId}` })
  })
  forage.registerTool(textStatsTool)
  forage.registerSkillExecutor(labelNotesExecutor)
  forage.on('run:end', (context) => {
    context.log({ level: 'debug', message: `Text Stats ${context.outcome} for ${context.runId}` })
  })
})
