import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes, OutlinerKeymap } from '../../editor/extensions'
import { collectBullets } from '../../editor/outlineModel'
import { OutlinerUi } from '../../editor/outlinerUi'
import { OutlinerChrome } from './OutlinerChrome'

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, BulletAttributes, OutlinerKeymap, OutlinerUi],
    content: {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: { nodeId: 'alpha', nodeType: 'user', collapsed: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha note' }] }],
        }],
      }],
    },
  })
}

describe('outliner chrome', () => {
  let editor: Editor

  beforeEach(() => {
    editor = makeEditor()
  })

  afterEach(() => editor.destroy())

  it('edits a matching bullet directly from search results', async () => {
    const user = userEvent.setup()
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search bullets'), 'Alpha')
    const result = screen.getByLabelText('Edit Alpha note')
    await user.clear(result)
    await user.type(result, 'Renamed note')
    await user.tab()

    expect(collectBullets(editor.state.doc)[0].text).toBe('Renamed note')
  })

  it('exposes explicit branch actions and sends deletion to trash', async () => {
    const user = userEvent.setup()
    const onTrashChange = vi.fn()
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={onTrashChange} />)
    const menuButton = editor.view.dom.querySelector('.bullet-menu') as HTMLButtonElement
    await user.click(menuButton)
    await user.click(screen.getByRole('menuitem', { name: 'Move to Trash' }))

    expect(onTrashChange).toHaveBeenCalledOnce()
    expect(onTrashChange.mock.calls[0][0]).toHaveLength(1)
    expect(collectBullets(editor.state.doc).some((entry) => entry.id === 'alpha')).toBe(false)
  })
})
