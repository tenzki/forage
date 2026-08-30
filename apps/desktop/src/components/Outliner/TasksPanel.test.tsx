import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { StableBulletAttributes } from '@forage/document'
import { OutlinerUi, getOutlinerUiState } from '../../editor/outlinerUi'
import { collectBullets } from '../../editor/outlineModel'
import { TasksPanel } from './TasksPanel'

function task(id: string, text: string, completed = false) {
  return {
    type: 'listItem',
    attrs: {
      nodeId: id, nodeType: 'user', collapsed: false,
      bulletKind: 'todo', completed, systemRole: null, dailyDate: null,
    },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), StableBulletAttributes, OutlinerUi],
    content: {
      type: 'doc', content: [{ type: 'bulletList', content: [
        task('completed', 'Completed task', true),
        task('open', 'Open task'),
      ] }],
    },
  })
}

describe('TasksPanel', () => {
  let editor: Editor
  beforeEach(() => { editor = makeEditor() })
  afterEach(() => editor.destroy())

  it('renders the live grouped projection and toggles the source node', async () => {
    const user = userEvent.setup()
    render(<TasksPanel editor={editor} onClose={vi.fn()} />)

    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual(['Open task', 'Completed task'])
    await user.click(screen.getByRole('checkbox', { name: 'Mark Open task complete' }))
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'open')?.completed).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Reopen Open task' })).toBeTruthy()
  })

  it('navigates to the original task instead of a copy', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<TasksPanel editor={editor} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Open Open task in outline' }))

    expect(getOutlinerUiState(editor).zoomId).toBe('open')
    expect(onClose).toHaveBeenCalledOnce()
  })
})
