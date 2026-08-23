import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from '../../editor/extensions'
import { InternalLink } from '../../editor/internalLinks'
import { collectBullets } from '../../editor/outlineModel'
import { InternalLinkMenu } from './InternalLinkMenu'

function linkedAlias(id: string) {
  return {
    type: 'listItem',
    attrs: { nodeId: id },
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: 'Beta project',
        marks: [{ type: 'internalLink', attrs: { targetId: 'beta' } }],
      }],
    }],
  }
}

function makeEditor(withAliases = false): Editor {
  const alpha = {
    type: 'listItem', attrs: { nodeId: 'alpha' },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] }],
  }
  const beta = {
    type: 'listItem', attrs: { nodeId: 'beta' },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Beta project' }] }],
  }
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes, InternalLink],
    content: {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: withAliases ? [alpha, linkedAlias('alias-one'), linkedAlias('alias-two'), beta] : [alpha, beta],
      }],
    },
  })
}

describe('internal link picker', () => {
  let editor: Editor | null = null

  afterEach(() => {
    editor?.view.dom.remove()
    editor?.destroy()
    editor = null
  })

  it('suggests matching items for [[ and inserts the selected stable link', async () => {
    const user = userEvent.setup()
    editor = makeEditor()
    document.body.appendChild(editor.view.dom)
    render(<InternalLinkMenu editor={editor} />)
    const alpha = collectBullets(editor.state.doc)[0]

    act(() => {
      editor!.chain()
        .setTextSelection(alpha.pos + 2 + alpha.text.length)
        .insertContent(' [[Beta')
        .run()
    })
    await user.click(await screen.findByRole('button', { name: /Beta project/ }))

    const anchor = editor.view.dom.querySelector<HTMLAnchorElement>('a[data-internal-node-id="beta"]')
    expect(anchor?.textContent).toBe('Beta project')
  })

  it('deduplicates reference-only bullets from their canonical target', async () => {
    editor = makeEditor(true)
    document.body.appendChild(editor.view.dom)
    render(<InternalLinkMenu editor={editor} />)
    const alpha = collectBullets(editor.state.doc)[0]

    act(() => {
      editor!.chain()
        .setTextSelection(alpha.pos + 2 + alpha.text.length)
        .insertContent(' [[Beta')
        .run()
    })

    expect(await screen.findAllByRole('button', { name: /Beta project/ })).toHaveLength(1)
  })
})
