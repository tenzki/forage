export { fauxAssistantMessage, fauxText, fauxToolCall, type Context } from '@earendil-works/pi-ai'
import {
  createModels, fauxProvider, getSystemMessageText,
  type AssistantMessage, type Context, type SimpleStreamOptions, type Tool, type TranscriptContext,
} from '@earendil-works/pi-ai'
import type { FauxProviderState } from '@earendil-works/pi-ai/providers/faux'

export type FauxResponseStep = AssistantMessage | ((context: Context, options: SimpleStreamOptions | undefined, state: FauxProviderState) => AssistantMessage | Promise<AssistantMessage>)

/** Expose the effective prompt/tools in assertions while exercising real durable provider requests. */
function assertionContext(context: TranscriptContext): Context {
  let systemPrompt = ''
  const tools = new Map<string, Tool>()
  for (const message of context.messages) {
    if (message.role !== 'system') continue
    const text = getSystemMessageText(message)
    if (text) systemPrompt = text
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
    for (const name of message.toolsRemoved ?? []) tools.delete(name.name)
  }
  return { systemPrompt, tools: [...tools.values()], messages: [...context.messages] }
}

export async function scriptedModel(responses: FauxResponseStep[]) {
  const faux = fauxProvider()
  const setResponses = faux.setResponses
  const script = (steps: FauxResponseStep[]) => setResponses(steps.map((step) => async (context, options, state) => {
    const message = typeof step === 'function' ? await step(assertionContext(context), options, state) : step
    return message.stopReason === 'stop' && message.content.some((part) => part.type === 'toolCall')
      ? { ...message, stopReason: 'toolUse' as const } : message
  }))
  const modelRuntime = createModels()
  modelRuntime.setProvider(faux.provider)
  script(responses)
  return { modelRuntime, model: faux.getModel(), faux: { ...faux, setResponses: script } }
}
