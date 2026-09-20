import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { Transaction } from '@tiptap/pm/state'
import { createInitialOutlineState, reduceOutlineEvent } from '@forage/domain'
import type { LocalAgentRun } from '../persistence/eventStore'
import { BulletAttributes } from '../editor/extensions'
import { InternalLink, OUTLINE_INTERNAL_LINK_EVENT } from '../editor/internalLinks'
import { collectBullets, findBullet, moveBulletTo, trashBullet } from '../editor/outlineModel'
import { placeRetainedExtensionSkillResult } from './extensionResultPlacement'
import { commitExtensionSkillResult } from './insertIntoEditor'
import { captureDocumentEvent, finalizeDocumentEvent } from '../editor/eventCapture'

function item(id: string, text: string) {
  return {
    type: 'listItem',
    attrs: { nodeId: id },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

function makeEditor(content?: object): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes, InternalLink],
    content: content ?? {
      type: 'doc',
      content: [{ type: 'bulletList', content: [item('destination', 'Destination'), item('candidate', 'Candidate')] }],
    },
  })
}

function retainedRun(): LocalAgentRun {
  return {
    id: 'run-retained',
    outlineId: 'outline-one',
    snapshot: {
      version: 2,
      execution: 'extension',
      runId: 'run-retained',
      executionMode: 'local',
      outlineId: 'outline-one',
      source: { nodeId: 'missing-invocation', text: '' },
      target: { parentId: 'missing-invocation' },
      baseRevision: 0,
      configurationRevision: 7,
      authority: { type: 'local-extension-executor', executor: { extensionId: 'dev.example.notes', executorId: 'label' } },
      localExecutorSnapshot: {
        version: 1,
        catalogRevision: 'a'.repeat(64),
        configurationRevision: 19,
        source: {
          installationId: 'removed-installation', extensionId: 'dev.example.notes',
          sourceRevision: 'source-one', entryDigest: 'b'.repeat(64), executorId: 'label',
        },
      },
      skill: {
        id: 'label', execution: 'extension', label: 'label', description: 'Label notes',
        executor: { extensionId: 'dev.example.notes', executorId: 'label' }, configuration: {},
      },
      context: {
        prompt: '',
        invocation: { id: 'missing-invocation', text: '/label', parentId: 'destination', documentOrder: 2 },
        roots: [{ id: 'destination', text: 'Destination', documentOrder: 0, children: [{ id: 'candidate', text: 'Candidate', documentOrder: 1 }] }],
        provenance: { ancestorPathIds: ['destination'], localParentId: 'destination', localBranchRootId: 'destination', explicitLinkedRootIds: [] },
      },
      plan: {
        selectedNodeIds: ['candidate'], requestedReferenceIds: ['candidate'], admittedReferenceIds: ['candidate'],
        annotations: [], data: {},
      },
    },
    status: 'completed_unplaced',
    attemptCount: 1,
    resultIdentity: 'result:run-retained',
    result: {
      version: 2,
      nodes: [{
        type: 'text',
        segments: [
          { type: 'text', text: 'Result for ' },
          { type: 'internal-reference', nodeId: 'candidate', label: 'Candidate snapshot' },
        ],
      }],
      sources: [],
    },
    retryOfRunId: null,
    cancelRequestedAt: null,
    errorCode: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:01.000Z',
  }
}

describe('retained extension result placement', () => {
  const editors: Editor[] = []
  afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

  it('recovers under a new live target without loading the removed extension and is idempotent', async () => {
    const editor = makeEditor()
    editors.push(editor)
    const repository = { placeAgentRunResult: vi.fn(async () => undefined) }

    const first = await placeRetainedExtensionSkillResult(editor, retainedRun(), 'destination', repository)
    const second = await placeRetainedExtensionSkillResult(editor, retainedRun(), 'destination', repository)

    expect(first).toEqual(['extension-result-run-retained-0'])
    expect(second).toEqual(first)
    expect(collectBullets(editor.state.doc).filter(({ id }) => id === first[0])).toHaveLength(1)
    expect(editor.view.dom.querySelector('a[data-internal-node-id="candidate"]')?.textContent).toBe('Candidate snapshot')
    expect(repository.placeAgentRunResult).toHaveBeenCalledTimes(2)

    const reopened = makeEditor(editor.getJSON())
    editors.push(reopened)
    expect(reopened.view.dom.querySelector('a[data-internal-node-id="candidate"]')?.textContent).toBe('Candidate snapshot')
    expect(collectBullets(reopened.state.doc).map(({ text }) => text)).toContain('Result for Candidate snapshot')
  })

  it('creates a separate ordinary snapshot for each new run', async () => {
    const editor = makeEditor()
    editors.push(editor)
    const repository = { placeAgentRunResult: vi.fn(async () => undefined) }
    const first = retainedRun()
    const second: LocalAgentRun = {
      ...retainedRun(),
      id: 'run-retained-again',
      snapshot: { ...retainedRun().snapshot, runId: 'run-retained-again' },
      resultIdentity: 'result:run-retained-again',
    }

    await placeRetainedExtensionSkillResult(editor, first, 'destination', repository)
    await placeRetainedExtensionSkillResult(editor, second, 'destination', repository)

    const resultIds = collectBullets(editor.state.doc)
      .map(({ id }) => id)
      .filter((id) => id.startsWith('extension-result-'))
    expect(resultIds).toEqual([
      'extension-result-run-retained-0',
      'extension-result-run-retained-again-0',
    ])
  })

  it('keeps the retained result pending when the chosen destination is missing', async () => {
    const editor = makeEditor()
    editors.push(editor)
    const repository = { placeAgentRunResult: vi.fn(async () => undefined) }
    const before = editor.getJSON()

    await expect(placeRetainedExtensionSkillResult(
      editor,
      retainedRun(),
      'removed-destination',
      repository,
    )).rejects.toThrow(/target is no longer available/i)

    expect(editor.getJSON()).toEqual(before)
    expect(repository.placeAgentRunResult).not.toHaveBeenCalled()
  })

  it('uses normal stable-link behavior across source rename, move, and trash', async () => {
    const editor = makeEditor()
    editors.push(editor)
    await placeRetainedExtensionSkillResult(
      editor,
      retainedRun(),
      'destination',
      { placeAgentRunResult: async () => undefined },
    )
    const beforeOutput = collectBullets(editor.state.doc).find(({ id }) => id === 'extension-result-run-retained-0')?.text
    const candidate = findBullet(editor.state.doc, 'candidate')!
    editor.view.dispatch(editor.state.tr.replaceWith(
      candidate.pos + 2,
      candidate.pos + 2 + candidate.node.firstChild!.content.size,
      editor.schema.text('Renamed candidate'),
    ))
    expect(moveBulletTo(editor, 'candidate', 'destination', 'inside')).toBe(true)

    const listener = vi.fn()
    window.addEventListener(OUTLINE_INTERNAL_LINK_EVENT, listener)
    editor.view.dom.querySelector('a[data-internal-node-id="candidate"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect((listener.mock.calls[0]?.[0] as CustomEvent | undefined)?.detail.targetId).toBe('candidate')
    window.removeEventListener(OUTLINE_INTERNAL_LINK_EVENT, listener)

    expect(trashBullet(editor, 'candidate')).not.toBeNull()
    expect(editor.view.dom.querySelector('.internal-link-broken')).toBeTruthy()
    expect(collectBullets(editor.state.doc).find(({ id }) => id === 'extension-result-run-retained-0')?.text).toBe(beforeOutput)
  })

  it('replays the one atomic ordinary-document event with reference marks intact', async () => {
    const editor = makeEditor({
      type: 'doc',
      content: [{ type: 'bulletList', content: [item('invocation', '/label'), item('candidate', 'Candidate')] }],
    })
    editors.push(editor)
    const before = editor.getJSON() as Record<string, unknown>
    let placementTransaction: Transaction | null = null
    editor.on('transaction', ({ transaction }) => {
      if (transaction.getMeta('forageChangeGroup') === 'run-event') placementTransaction = transaction
    })

    commitExtensionSkillResult(editor, 'invocation', 'label', 'run-event', {
      version: 2,
      nodes: [{ type: 'text', segments: [{ type: 'internal-reference', nodeId: 'candidate', label: 'Candidate link' }] }],
      sources: [],
    }, ['candidate'])

    expect(placementTransaction).not.toBeNull()
    const captured = captureDocumentEvent(placementTransaction!, [], {
      outlineId: 'outline-one', actorId: 'owner-one', deviceId: 'device-one', baseRevision: 0,
      nextEventId: () => 'event-one', nextChangeGroupId: () => 'change-one',
      now: () => '2026-09-20T10:00:00.000Z', origin: 'desktop',
    })
    if (captured?.type !== 'document.steps_applied') throw new Error('Expected one ordinary document event')
    expect(captured.payload.steps).toHaveLength(2)
    const event = await finalizeDocumentEvent(captured!)
    const replayed = reduceOutlineEvent(createInitialOutlineState(before), event)

    expect(replayed.doc).toEqual(editor.getJSON())
    expect(JSON.stringify(replayed.doc)).toContain('internalLink')
    expect(JSON.stringify(replayed.doc)).toContain('candidate')
  })
})
