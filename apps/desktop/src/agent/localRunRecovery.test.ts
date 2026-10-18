import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { runInputSchema, type LocalRunResult } from '@forage/agent-runtime'
import { BulletAttributes } from '../editor/extensions'
import type { LocalAgentRunHistory } from '../persistence/eventStore'
import { LocalAgentExecutor } from './localExecutor'
import { recoverLocalAgentRuns } from './localRunRecovery'

const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); vi.restoreAllMocks() })
function fixture(status: 'queued' | 'completed_unplaced' = 'queued', target = 'invocation') {
  const input = runInputSchema.parse({
    version: 1, runtime: 'pi-durable', runId: 'run-recovery', executionMode: 'local', outlineId: 'outline',
    credentialRef: 'credential', configurationRevision: 1, baseRevision: 0,
    source: { nodeId: 'invocation', text: 'Research.' }, target: { parentId: target },
    thread: { callId: 'run-recovery', turn: 1 },
    agent: { id: 'agent', name: 'Agent', description: '', systemPrompt: 'Work.', toolIds: [], modelId: 'gpt-5' },
    skill: { id: 'research', label: 'research', description: '', systemPrompt: 'Work.', requiredToolIds: [], agentId: 'agent' },
    effectiveToolIds: [], prompt: 'Research.', context: [],
  })
  const result: LocalRunResult = { version: 1, nodes: [{ type: 'text', text: 'Recovered evidence.' }], sources: [] }
  const history: LocalAgentRunHistory[] = [{ run: {
    id: input.runId, outlineId: input.outlineId, snapshot: input, status, result: status === 'queued' ? null : result,
    resultIdentity: null, retryOfRunId: null, cancelRequestedAt: null, attemptCount: 1,
    errorCode: 'desktop_restarted', createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T10:00:00Z',
  }, activity: [] }]
  const editor = new Editor({ element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes],
    content: { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', attrs: { nodeId: 'invocation' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '/research Research.' }] }] }] }] },
  })
  editors.push(editor)
  const options = { onActivity: vi.fn(), registerCancellation: vi.fn(), acknowledgeEdits: vi.fn(async () => undefined) }
  return { input, result, history, editor, options }
}

describe('local startup recovery', () => {
  it('resumes the original admission once and commits the result using its atomic placement group', async () => {
    const f = fixture()
    let finish!: (result: LocalRunResult) => void
    const completion = new Promise<LocalRunResult>((resolve) => { finish = resolve })
    const resume = vi.spyOn(LocalAgentExecutor.prototype, 'resume').mockResolvedValue({ runId: f.input.runId, completion, cancel: vi.fn(async () => undefined) })
    const groups: unknown[] = []
    f.editor.on('transaction', ({ transaction }) => { if (transaction.docChanged) groups.push(transaction.getMeta('forageChangeGroup')) })
    const first = recoverLocalAgentRuns(f.editor, f.history, f.options)
    const second = recoverLocalAgentRuns(f.editor, f.history, f.options)
    finish(f.result)
    await Promise.all([first, second])
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith(f.input, expect.anything())
    expect(groups).toContain('agent-result:run-recovery')
    expect(f.editor.getText()).toContain('Recovered evidence.')
    expect(f.options.acknowledgeEdits).toHaveBeenCalledTimes(1)
  })

  it('retains a completed result when its stable destination is gone, without invoking a model', async () => {
    const f = fixture('completed_unplaced', 'deleted')
    const resume = vi.spyOn(LocalAgentExecutor.prototype, 'resume')
    await recoverLocalAgentRuns(f.editor, f.history, f.options)
    expect(resume).not.toHaveBeenCalled()
    expect(f.editor.getText()).not.toContain('Recovered evidence.')
    expect(f.options.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'complete', placementPending: true }))
  })

  it('does not take over newly admitted work in this process', async () => {
    const f = fixture()
    f.history[0]!.run.errorCode = null
    const resume = vi.spyOn(LocalAgentExecutor.prototype, 'resume')
    await recoverLocalAgentRuns(f.editor, f.history, f.options)
    expect(resume).not.toHaveBeenCalled()
  })
})
