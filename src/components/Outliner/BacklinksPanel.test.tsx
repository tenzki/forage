import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from '../../editor/extensions'
import { InternalLink } from '../../editor/internalLinks'
import { getOutlinerUiState, OutlinerUi } from '../../editor/outlinerUi'
import { BacklinksPanel } from './BacklinksPanel'

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, BulletAttributes, InternalLink, OutlinerUi],
    content: {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          {
            type: 'listItem', attrs: { nodeId: 'root' },
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Danica Banic #person' }] },
              {
                type: 'bulletList',
                content: [{
                  type: 'listItem', attrs: { nodeId: 'children' },
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'children' }] },
                    {
                      type: 'bulletList',
                      content: [{
                        type: 'listItem', attrs: { nodeId: 'parent' },
                        content: [
                          { type: 'paragraph', content: [{ type: 'text', text: 'Vaislije Babic' }] },
                          {
                            type: 'bulletList',
                            content: [{
                              type: 'listItem', attrs: { nodeId: 'source' },
                              content: [{
                                type: 'paragraph',
                                content: [{ type: 'text', text: 'Destination', marks: [{ type: 'internalLink', attrs: { targetId: 'target' } }] }],
                              }],
                            }],
                          },
                        ],
                      }],
                    },
                  ],
                }],
              },
            ],
          },
          {
            type: 'listItem', attrs: { nodeId: 'target' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Destination' }] }],
          },
        ],
      }],
    },
  })
}

describe('backlinks panel', () => {
  let editor: Editor | null = null

  afterEach(() => {
    editor?.destroy()
    editor = null
  })

  it('lists incoming sources and navigates back to them', async () => {
    const user = userEvent.setup()
    editor = makeEditor()
    render(<BacklinksPanel editor={editor} targetId="target" />)

    expect(screen.getByRole('region', { name: 'Backlinks' })).toBeTruthy()
    await user.click(screen.getByRole('button', {
      name: 'Danica Banic #person › children › Vaislije Babic',
    }))
    expect(getOutlinerUiState(editor).zoomId).toBe('parent')
  })
})
