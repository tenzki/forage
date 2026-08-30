import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { StableBulletAttributes } from '@forage/document'
import type { JsonValue, TrashEntry } from '../../types/tree'
import { TrashPanel } from './TrashPanel'

type TestNode =
  | { type: string; attrs: Record<string, JsonValue>; content: TestNode[] }
  | { type: string; content: TestNode[] }
  | { type: string; text: string }

function item(
  id: string,
  text: string,
  systemRole: 'daily-notes' | 'daily-note' | null = null,
  dailyDate: string | null = null,
  children: TestNode[] = [],
): TestNode {
  return {
    type: 'listItem',
    attrs: {
      nodeId: id,
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
      systemRole,
      dailyDate,
    },
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      ...(children.length ? [{ type: 'bulletList', content: children }] : []),
    ],
  }
}

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), StableBulletAttributes],
    content: {
      type: 'doc',
      content: [{ type: 'bulletList', content: [
        item('daily', 'Daily Notes', 'daily-notes', null, [
          item('live-date', 'August 30, 2026', 'daily-note', '2026-08-30'),
        ]),
      ] }],
    },
  })
}

describe('TrashPanel', () => {
  let editor: Editor

  beforeEach(() => { editor = makeEditor() })
  afterEach(() => editor.destroy())

  it('reports restore conflicts without removing the trash entry', async () => {
    const user = userEvent.setup()
    const onError = vi.fn()
    const onRestore = vi.fn()
    const onChange = vi.fn()
    const entry: TrashEntry = {
      id: 'trash-entry',
      deletedAt: '2026-08-30T12:00:00.000Z',
      originalParentId: 'daily',
      originalIndex: 0,
      node: item('trashed-date', 'August 30, 2026', 'daily-note', '2026-08-30'),
    }
    render(<TrashPanel
      editor={editor}
      entries={[entry]}
      onClose={vi.fn()}
      onChange={onChange}
      onRestore={onRestore}
      onError={onError}
    />)

    await user.click(screen.getByRole('button', { name: 'Restore' }))

    expect(onError).toHaveBeenCalledWith(
      'The branch could not be restored because its ID or daily-note date is already in use, or its system metadata is invalid.',
    )
    expect(onRestore).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
})
