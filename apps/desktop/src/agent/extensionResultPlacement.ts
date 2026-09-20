import type { Editor } from '@tiptap/react'
import { parseStructuredResult } from '@forage/agent-runtime'
import type { LocalAgentRun } from '../persistence/eventStore'
import { insertExtensionSkillResult } from './insertIntoEditor'

export interface ExtensionResultPlacementRepository {
  placeAgentRunResult(runId: string, placedAt: string): Promise<void>
}

/**
 * Place a retained result without importing or invoking its extension. This is
 * deliberately generic so removal/disablement cannot make paid output unreadable
 * or prevent recovery under another live bullet.
 */
export async function placeRetainedExtensionSkillResult(
  editor: Editor,
  run: LocalAgentRun,
  targetNodeId: string,
  repository: ExtensionResultPlacementRepository,
  now: () => string = () => new Date().toISOString(),
): Promise<string[]> {
  if (run.status !== 'completed_unplaced' || run.snapshot.version !== 2 || !run.result) {
    throw new Error('This run has no retained extension result awaiting placement.')
  }
  const result = parseStructuredResult(run.result, {
    allowedReferenceIds: run.snapshot.plan.admittedReferenceIds,
  })
  if (result.version !== 2) throw new Error('The retained extension result is not reference-aware.')
  const nodeIds = insertExtensionSkillResult(
    editor,
    targetNodeId,
    run.id,
    result,
    run.snapshot.plan.admittedReferenceIds,
  )
  await repository.placeAgentRunResult(run.id, now())
  return nodeIds
}
