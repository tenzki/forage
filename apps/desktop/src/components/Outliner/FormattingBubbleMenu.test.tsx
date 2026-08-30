import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { FormattingBubbleMenu, normalizedUrl } from './FormattingBubbleMenu'

describe('formatting bubble menu', () => {
  let editor: Editor | null = null

  afterEach(() => editor?.destroy())

  it('normalizes safe external links and rejects unsafe protocols', () => {
    expect(normalizedUrl('example.com')).toBe('https://example.com/')
    expect(normalizedUrl('mailto:hello@example.com')).toBe('mailto:hello@example.com')
    expect(() => normalizedUrl('javascript:alert(1)')).toThrow(/HTTP, HTTPS, or email/)
  })

  it('applies formatting to the selected text', async () => {
    const user = userEvent.setup()
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit],
      content: { type: 'doc', content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'Alpha' }],
      }] },
    })
    document.body.append(editor.view.dom)
    render(<FormattingBubbleMenu editor={editor} />)
    act(() => { editor?.chain().focus().setTextSelection({ from: 1, to: 6 }).run() })

    await user.click(await screen.findByRole('button', { name: 'Bold' }))

    expect(editor.isActive('bold')).toBe(true)
    expect(editor.getJSON().content?.[0].content?.[0].marks?.[0].type).toBe('bold')
  })
})
