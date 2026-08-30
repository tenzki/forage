import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { resolveAgentContext } from '../agent/context'
import { BulletAttributes } from './extensions'
import { InternalLink } from './internalLinks'
import {
  clearSkillContext,
  showSkillContext,
  showSkillContextError,
  SkillContextPreview,
} from './contextPreview'

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      BulletAttributes,
      InternalLink,
      SkillContextPreview,
    ],
    content: {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem', attrs: { nodeId: 'local' }, content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Local' }] },
            { type: 'bulletList', content: [{
              type: 'listItem', attrs: { nodeId: 'command' }, content: [{
                type: 'paragraph', content: [
                  { type: 'text', text: '/ask ' },
                  { type: 'text', text: 'Remote', marks: [{ type: 'internalLink', attrs: { targetId: 'remote' } }] },
                ],
              }],
            }] },
          ],
        }, {
          type: 'listItem', attrs: { nodeId: 'remote' }, content: [{
            type: 'paragraph', content: [{ type: 'text', text: 'Remote' }],
          }],
        }],
      }],
    },
  })
}

describe('agent context preview', () => {
  let editor: Editor | null = null
  afterEach(() => editor?.destroy())

  it('decorates local, referenced, and excluded invocation nodes without changing content', () => {
    editor = makeEditor()
    const before = editor.getJSON()

    showSkillContext(editor, resolveAgentContext(editor.state.doc, 'command'))

    expect(editor.view.dom.querySelector('li[data-node-id="local"]')?.classList).toContain('skill-context-local')
    expect(editor.view.dom.querySelector('li[data-node-id="remote"]')?.classList).toContain('skill-context-reference')
    expect(editor.view.dom.querySelector('li[data-node-id="command"]')?.classList).toContain('skill-context-invocation')
    expect(editor.getJSON()).toEqual(before)

    clearSkillContext(editor)
    expect(editor.view.dom.querySelector('.skill-context-local')).toBeNull()
    expect(editor.getJSON()).toEqual(before)
  })

  it('marks preflight errors on the invocation without changing the document', () => {
    editor = makeEditor()
    const before = editor.getJSON()

    showSkillContextError(editor, 'command', 'Referenced node is missing.')

    const command = editor.view.dom.querySelector('li[data-node-id="command"]')
    expect(command?.classList).toContain('skill-context-error')
    expect(command?.getAttribute('title')).toContain('Referenced node is missing.')
    expect(editor.getJSON()).toEqual(before)
  })
})
