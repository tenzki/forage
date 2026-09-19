import {
  defineExtension,
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

export default defineExtension((forage) => {
  forage.on('run:start', (context) => {
    context.log({ level: 'debug', message: `Text Stats started for ${context.runId}` })
  })
  forage.registerTool(textStatsTool)
  forage.on('run:end', (context) => {
    context.log({ level: 'debug', message: `Text Stats ${context.outcome} for ${context.runId}` })
  })
})
