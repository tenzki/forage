// Starting skill runs from outside the slash menu.
//
// The slash menu owns everything a run needs (settings, credentials, the
// extension inventory), so other surfaces — the reader peek's "Summarize into
// outline" and the activity panel's steering box — ask it to run a skill through
// a window event instead of duplicating that plumbing.

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

export interface SkillRunRequest {
  invocationNodeId: string
  skillLabel: string
  prompt: string
  steering?: SkillRunSteering
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
