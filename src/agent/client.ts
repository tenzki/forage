// Direct Anthropic SDK calls from the frontend. The user provides their own key
// (stored via plugin-store). dangerouslyAllowBrowser is safe here: this is a
// desktop webview, not a public web page — no third-party script can read the
// key, and the key is the user's own.

import Anthropic from '@anthropic-ai/sdk'
import type { Skill } from './skills'

// Latest, most capable Sonnet at time of writing.
const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 1500

export interface GenerateOptions {
  /** Called with each incremental text delta as it streams in. */
  onDelta: (textSoFar: string) => void
  /** Abort an in-flight generation (cancellation, AGNT requirement). */
  signal?: AbortSignal
}

export interface GenerateInput {
  skill: Skill
  /** The text the user typed after the slash command, e.g. "/research X" → "X". */
  prompt: string
  /** Ancestor bullet texts, nearest-last, used as branch context (AGNT-02). */
  context: string[]
}

/**
 * Run a skill against the user's prompt + branch context, streaming the result.
 * Returns the full accumulated text when complete. Throws on missing key or API error.
 */
export async function generate(
  apiKey: string,
  { skill, prompt, context }: GenerateInput,
  { onDelta, signal }: GenerateOptions,
): Promise<string> {
  if (!apiKey) {
    throw new Error('No Anthropic API key set. Open Settings and paste your key.')
  }

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })

  const contextBlock = context.length
    ? `Outline context (outer to inner):\n${context.map((c) => `- ${c}`).join('\n')}\n\n`
    : ''
  const userMessage = `${contextBlock}Task: ${prompt}`

  let full = ''
  const stream = client.messages.stream(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: skill.systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    },
    { signal },
  )

  stream.on('text', (delta: string) => {
    full += delta
    onDelta(full)
  })

  await stream.finalMessage()
  return full
}
