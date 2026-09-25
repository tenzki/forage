// Starting skill runs from outside the slash menu.
//
// The slash menu owns everything a run needs (settings, credentials, the
// extension inventory), so other surfaces — the reader peek's "Summarize into
// outline" and the activity panel's steering box — ask it to run a skill through
// a window event instead of duplicating that plumbing.

import type { SkillCallGroup } from './skillCalls'

export const OUTLINE_RUN_SKILL_EVENT = 'outline:run-skill'

/** A follow-up iteration of an earlier run of the same skill on the same bullet. */
export interface SkillRunSteering {
  /** The user's note that this iteration answers. */
  note: string
  /** The prompt of the first iteration, shown as the call's label. */
  basePrompt: string
  /** 1-based iteration number of the run being started. */
  iteration: number
}

/** A reply that continues a call's stored agent conversation. */
export interface SkillRunConversation {
  callId: string
  /** Turn number of the run being started; turn 1 starts the conversation. */
  turn: number
  /** Run whose outline output a revision replaces, for superseded-version display. */
  replacesRunId?: string
}

export interface SkillRunRequest {
  invocationNodeId: string
  skillLabel: string
  prompt: string
  steering?: SkillRunSteering
  conversation?: SkillRunConversation
}

/**
 * The run for a reply to a call that keeps an agent conversation, or null when
 * the call has none (server mode, extension skills, older history) and the reply
 * takes the legacy single-shot steering path.
 */
export function conversationReply(group: SkillCallGroup, note: string): SkillRunRequest | null {
  const callId = group.latest.thread?.callId
  if (!callId || !group.nodeId || !group.skillLabel) return null
  const turns = group.iterations.map(({ call }) => call).filter((call) => call.thread?.callId === callId)
  const steering = { note, basePrompt: group.prompt, iteration: group.iterations.length + 1 }
  const request = { invocationNodeId: group.nodeId, skillLabel: group.skillLabel, steering }
  // Only completed turns stay in the conversation. Without one there is nothing to
  // resume, so the reply starts the conversation over with the note in its prompt.
  if (!turns.some((call) => call.status === 'complete')) {
    return {
      ...request,
      prompt: steeredPrompt(group.prompt || group.skillLabel, note, steering.iteration, []),
      conversation: { callId, turn: 1 },
    }
  }
  const turn = Math.max(...turns.map((call) => call.thread!.turn)) + 1
  const replaced = [...turns].reverse().find((call) => call.status === 'complete' && !call.answer)
  return {
    ...request,
    prompt: note,
    conversation: { callId, turn, ...(replaced ? { replacesRunId: replaced.id } : {}) },
  }
}

export function requestSkillRun(request: SkillRunRequest): void {
  window.dispatchEvent(new CustomEvent<SkillRunRequest>(OUTLINE_RUN_SKILL_EVENT, { detail: request }))
}

const REVISION_MARKER = /\n\nRevision (\d+) requested by the user: (.*?)\n/su

/**
 * The prompt for a steered iteration: the original request, the user's note, and
 * the output being replaced, so the agent revises rather than starts over.
 */
export function steeredPrompt(basePrompt: string, note: string, iteration: number, previousResult: string[]): string {
  const previous = previousResult.length ? previousResult.join('\n') : '(the previous iteration produced no bullets)'
  return [
    basePrompt,
    '',
    `Revision ${iteration} requested by the user: ${note.replace(/\s+/gu, ' ').trim()}`,
    'Write the complete revised result; it replaces the previous one.',
    'Previous result:',
    previous,
  ].join('\n')
}

/** Split a stored run prompt back into the original request and its steering note. */
export function parseSteeredPrompt(prompt: string): { basePrompt: string; note?: string; iteration?: number } {
  const match = REVISION_MARKER.exec(prompt)
  if (!match) return { basePrompt: prompt }
  return {
    basePrompt: prompt.slice(0, match.index),
    note: match[2]!.trim(),
    iteration: Number(match[1]),
  }
}

/**
 * The output an iteration replaced, kept in memory so the activity panel can
 * show an earlier version after it has left the outline.
 */
const replacedOutputs = new Map<string, string[]>()

export function recordReplacedOutput(runId: string, lines: string[]): void {
  replacedOutputs.set(runId, lines)
}

export function replacedOutput(runId: string): string[] | undefined {
  return replacedOutputs.get(runId)
}
