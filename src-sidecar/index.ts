/**
 * AI Sidecar entry point.
 * Reads JSONL from stdin, dispatches commands, writes JSONL responses to stdout.
 *
 * Protocol: each message is a single JSON line terminated by \n.
 * Lines MUST be split on \n byte only — not Unicode line separators.
 *
 * Supported commands:
 *   { type: 'ping' }                              -> { type: 'pong' }
 *   { type: 'get_settings' }                      -> { type: 'settings', data: {...} }
 *   { type: 'save_settings', data: {...} }        -> { type: 'settings_saved' }
 *   { type: 'summarize', id?, messages: [...] }  -> { type: 'summary', id?, content: '...' }
 *   { type: 'prompt', id, text, skill, messages, systemPrompt }
 *     -> streams: { type: 'message_update', id, assistantMessageEvent: { type: 'text_delta', delta } }
 *     -> then:   { type: 'turn_end', id }
 *     -> then:   { type: 'agent_end', id }
 *   { type: 'abort' }                             -> cancels current generation
 */

import { createInterface } from 'node:readline'
import { loadSettings, saveSettings } from './keystore.ts'
import { streamSimple } from '@mariozechner/pi-ai'
import { getModel } from '@mariozechner/pi-ai'
import type { Message } from '@mariozechner/pi-ai'
import { askSkill } from './skills/ask.ts'
import { researchSkill } from './skills/research.ts'
import { brainstormSkill } from './skills/brainstorm.ts'

// APP_DATA_DIR must be set by Tauri when spawning the sidecar
const APP_DATA_DIR = process.env['APP_DATA_DIR'] ?? ''

if (!APP_DATA_DIR) {
  process.stderr.write('[sidecar] WARNING: APP_DATA_DIR is not set. Settings will use empty string as path.\n')
}

// ---------- Skills registry ----------

type SkillDef = { id: string; systemPrompt: string }

const SKILLS: Record<string, SkillDef> = {
  ask: askSkill,
  research: researchSkill,
  brainstorm: brainstormSkill,
}

// ---------- Abort controller (single active generation) ----------

let currentAbortController: AbortController | null = null

// ---------- Utilities ----------

/**
 * Write a single JSONL response to stdout (terminated by \n).
 */
function respond(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/**
 * Write an error response to stdout.
 */
function respondError(message: string, id?: string): void {
  const res: Record<string, unknown> = { type: 'error', message }
  if (id !== undefined) res['id'] = id
  respond(res)
}

// ---------- Command Types ----------

type BaseCommand = { type: string; id?: string }
type PingCommand = BaseCommand & { type: 'ping' }
type GetSettingsCommand = BaseCommand & { type: 'get_settings' }
type SaveSettingsCommand = BaseCommand & { type: 'save_settings'; data: Record<string, unknown> }
type SummarizeCommand = BaseCommand & {
  type: 'summarize'
  messages: Array<{ role: string; content: string }>
}
type PromptCommand = BaseCommand & {
  type: 'prompt'
  id: string
  text: string
  skill?: string
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
  systemPrompt?: string
}
type AbortCommand = BaseCommand & { type: 'abort' }
type Command =
  | PingCommand
  | GetSettingsCommand
  | SaveSettingsCommand
  | SummarizeCommand
  | PromptCommand
  | AbortCommand
  | BaseCommand

// ---------- Prompt handler using pi-ai ----------

async function handlePrompt(cmd: PromptCommand): Promise<void> {
  const { id, text, skill, messages: contextMessages } = cmd

  // Load settings to get API key and model
  const settings = loadSettings(APP_DATA_DIR) as Record<string, unknown>
  const providers = (settings['providers'] ?? {}) as Record<string, { apiKey?: string; enabled?: boolean }>
  const defaultModel = (settings['defaultModel'] as string | undefined) ?? ''

  // Find active provider
  let apiKey: string | undefined
  let providerName: string | undefined

  for (const [name, cfg] of Object.entries(providers)) {
    if (cfg.enabled && cfg.apiKey) {
      apiKey = cfg.apiKey
      providerName = name
      break
    }
  }

  if (!apiKey || !providerName) {
    respondError(
      'No API key configured. Open Settings to add one.',
      id
    )
    return
  }

  // Look up skill system prompt
  const skillDef = skill ? SKILLS[skill] : SKILLS['ask']
  const systemPrompt = skillDef?.systemPrompt ?? 'You are a helpful assistant.'

  // Build messages array for pi-ai
  // Context messages come first, then the user's current text
  const piMessages: Message[] = []

  if (contextMessages && contextMessages.length > 0) {
    for (const m of contextMessages) {
      if (m.role === 'assistant') {
        piMessages.push({
          role: 'user',
          content: `[Assistant's previous response]: ${m.content}`,
          timestamp: Date.now(),
        })
      } else {
        piMessages.push({
          role: 'user',
          content: m.content,
          timestamp: Date.now(),
        })
      }
    }
  }

  // Add the actual user prompt as final message
  piMessages.push({
    role: 'user',
    content: text,
    timestamp: Date.now(),
  })

  // Determine model based on provider and settings
  let model
  try {
    if (providerName === 'anthropic') {
      const modelId = (defaultModel || 'claude-3-5-haiku-20241022') as Parameters<typeof getModel>[1] & string
      try {
        model = getModel('anthropic', modelId as any)
      } catch {
        model = getModel('anthropic', 'claude-3-5-haiku-20241022')
      }
    } else if (providerName === 'openai') {
      const modelId = (defaultModel || 'gpt-4o-mini') as any
      try {
        model = getModel('openai', modelId)
      } catch {
        model = getModel('openai', 'gpt-4o-mini' as any)
      }
    } else if (providerName === 'google') {
      const modelId = (defaultModel || 'gemini-1.5-flash') as any
      try {
        model = getModel('google', modelId)
      } catch {
        model = getModel('google', 'gemini-1.5-flash' as any)
      }
    } else {
      respondError(`Unsupported provider: ${providerName}. Configure Anthropic, OpenAI, or Google.`, id)
      return
    }
  } catch (e) {
    respondError(`Failed to get model for provider ${providerName}: ${String(e)}`, id)
    return
  }

  // Create abort controller for this generation
  const abortController = new AbortController()
  currentAbortController = abortController

  try {
    const eventStream = streamSimple(model, {
      systemPrompt,
      messages: piMessages,
    }, {
      apiKey,
      signal: abortController.signal,
    })

    for await (const event of eventStream) {
      if (abortController.signal.aborted) break

      if (event.type === 'text_delta') {
        respond({
          type: 'message_update',
          id,
          assistantMessageEvent: {
            type: 'text_delta',
            delta: event.delta,
          },
        })
      }
    }

    if (!abortController.signal.aborted) {
      respond({ type: 'turn_end', id })
      respond({ type: 'agent_end', id })
    }
  } catch (e: unknown) {
    const err = e as Error
    if (err?.name === 'AbortError' || abortController.signal.aborted) {
      // Cancelled — don't send error
      process.stderr.write(`[sidecar] Generation ${id} aborted.\n`)
    } else {
      respondError(`Generation failed: ${String(e)}`, id)
    }
  } finally {
    if (currentAbortController === abortController) {
      currentAbortController = null
    }
  }
}

// ---------- Command Handlers ----------

async function handleCommand(cmd: Command): Promise<void> {
  switch (cmd.type) {
    case 'ping': {
      const res: Record<string, unknown> = { type: 'pong' }
      if (cmd.id !== undefined) res['id'] = cmd.id
      respond(res)
      break
    }

    case 'get_settings': {
      try {
        const data = loadSettings(APP_DATA_DIR)
        const res: Record<string, unknown> = { type: 'settings', data }
        if (cmd.id !== undefined) res['id'] = cmd.id
        respond(res)
      } catch (err) {
        respondError(`Failed to load settings: ${String(err)}`, cmd.id)
      }
      break
    }

    case 'save_settings': {
      const saveCmd = cmd as SaveSettingsCommand
      try {
        saveSettings(APP_DATA_DIR, saveCmd.data)
        const res: Record<string, unknown> = { type: 'settings_saved' }
        if (cmd.id !== undefined) res['id'] = cmd.id
        respond(res)
      } catch (err) {
        respondError(`Failed to save settings: ${String(err)}`, cmd.id)
      }
      break
    }

    case 'summarize': {
      const sumCmd = cmd as SummarizeCommand
      try {
        const summary = await summarizeMessages(sumCmd.messages)
        const res: Record<string, unknown> = { type: 'summary', content: summary }
        if (cmd.id !== undefined) res['id'] = cmd.id
        respond(res)
      } catch (err) {
        respondError(`Failed to summarize: ${String(err)}`, cmd.id)
      }
      break
    }

    case 'prompt': {
      await handlePrompt(cmd as PromptCommand)
      break
    }

    case 'abort': {
      if (currentAbortController) {
        currentAbortController.abort()
        currentAbortController = null
        process.stderr.write('[sidecar] Aborted current generation.\n')
      }
      break
    }

    default: {
      respondError(`Unknown command type: ${cmd.type}`, cmd.id)
      break
    }
  }
}

/**
 * Summarize a conversation using the active LLM provider from settings.
 * Falls back to a simple concatenation if no provider is configured.
 */
async function summarizeMessages(
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const settings = loadSettings(APP_DATA_DIR) as Record<string, unknown>

  // Determine active provider and model
  const providers = (settings['providers'] ?? {}) as Record<string, { apiKey?: string; enabled?: boolean }>
  const defaultModel = (settings['defaultModel'] as string | undefined) ?? ''

  // Try Anthropic first, then OpenAI, then Google
  let apiKey: string | undefined
  let provider: string | undefined

  for (const [name, cfg] of Object.entries(providers)) {
    if (cfg.enabled && cfg.apiKey) {
      apiKey = cfg.apiKey
      provider = name
      break
    }
  }

  if (!apiKey || !provider) {
    // No provider configured — return a simple fallback summary
    const preview = messages
      .slice(-3)
      .map(m => `${m.role}: ${m.content.slice(0, 100)}`)
      .join('\n')
    return `[No LLM provider configured. Recent context:\n${preview}]`
  }

  const systemPrompt =
    'Summarize the following conversation concisely, preserving key facts, decisions, and context needed for continuation.'

  // Build prompt for the LLM
  const conversationText = messages
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n')

  const fullPrompt = `${systemPrompt}\n\nConversation:\n${conversationText}`

  // Use fetch (available in Node 18+) to call the provider API
  if (provider === 'anthropic') {
    const model = defaultModel || 'claude-3-5-haiku-20241022'
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{ role: 'user', content: fullPrompt }],
      }),
    })
    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`)
    }
    const data = await response.json() as { content: Array<{ type: string; text: string }> }
    return data.content.find(b => b.type === 'text')?.text ?? '[empty summary]'
  }

  if (provider === 'openai') {
    const model = defaultModel || 'gpt-4o-mini'
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{ role: 'user', content: fullPrompt }],
      }),
    })
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`)
    }
    const data = await response.json() as { choices: Array<{ message: { content: string } }> }
    return data.choices[0]?.message.content ?? '[empty summary]'
  }

  if (provider === 'google') {
    const model = defaultModel || 'gemini-1.5-flash'
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
          generationConfig: { maxOutputTokens: 512 },
        }),
      }
    )
    if (!response.ok) {
      throw new Error(`Google API error: ${response.status}`)
    }
    const data = await response.json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>
    }
    return data.candidates[0]?.content.parts[0]?.text ?? '[empty summary]'
  }

  return `[Unsupported provider: ${provider}]`
}

// ---------- Main stdin loop ----------

process.stderr.write('[sidecar] Starting. Listening on stdin...\n')

const rl = createInterface({
  input: process.stdin,
  terminal: false,
  // Split on \n byte only (per pi RPC spec — not Unicode line separators)
  crlfDelay: Infinity,
})

rl.on('line', (line: string) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let cmd: Command
  try {
    cmd = JSON.parse(trimmed) as Command
  } catch {
    respondError(`Malformed JSON: ${trimmed.slice(0, 80)}`)
    return
  }

  if (!cmd.type || typeof cmd.type !== 'string') {
    respondError('Command missing required "type" field')
    return
  }

  // Run async handler — errors are caught inside handleCommand
  handleCommand(cmd).catch((err: unknown) => {
    respondError(`Internal error: ${String(err)}`, cmd.id)
  })
})

rl.on('close', () => {
  process.stderr.write('[sidecar] stdin closed. Exiting.\n')
  process.exit(0)
})
