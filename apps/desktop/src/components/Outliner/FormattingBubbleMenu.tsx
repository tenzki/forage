import { useState } from 'react'
import {
  Bold,
  Code,
  Italic,
  Link as LinkIcon,
  Strikethrough,
  Underline,
  Unlink,
} from 'lucide-react'
import { useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'

export function normalizedUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Enter a link destination.')
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(candidate)
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
    throw new Error('Links must use HTTP, HTTPS, or email.')
  }
  return url.toString()
}

interface MarkButtonProps {
  label: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}

function MarkButton({ label, active, onClick, children }: MarkButtonProps) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={active ? 'is-active' : ''}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

const bubbleOptions = { placement: 'top' as const, offset: 7 }
const showForSelection = ({ state }: { state: Editor['state'] }) => !state.selection.empty

export function FormattingBubbleMenu({ editor }: { editor: Editor | null }) {
  const activeMarks = useEditorState({
    editor,
    selector: ({ editor: current }) => current ? {
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      underline: current.isActive('underline'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      link: current.isActive('link'),
    } : null,
  })
  const [editingLink, setEditingLink] = useState(false)
  const [href, setHref] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)

  if (!editor || !activeMarks) return null

  function openLinkEditor() {
    setHref(editor?.getAttributes('link').href ?? '')
    setLinkError(null)
    setEditingLink(true)
  }

  function applyLink(event: React.FormEvent) {
    event.preventDefault()
    if (!editor) return
    try {
      editor.chain().focus().extendMarkRange('link').setLink({ href: normalizedUrl(href) }).run()
      setEditingLink(false)
      setLinkError(null)
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <BubbleMenu
      editor={editor}
      className="formatting-bubble"
      options={bubbleOptions}
      updateDelay={0}
      shouldShow={showForSelection}
    >
      {editingLink ? (
        <form className="formatting-link-form" onSubmit={applyLink}>
          <input
            aria-label="Link destination"
            placeholder="https://example.com"
            value={href}
            onChange={(event) => setHref(event.target.value)}
            autoFocus
          />
          <button type="submit">Apply</button>
          <button type="button" onClick={() => setEditingLink(false)}>Cancel</button>
          {linkError && <small role="alert">{linkError}</small>}
        </form>
      ) : (
        <>
          <MarkButton label="Bold" active={activeMarks.bold} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></MarkButton>
          <MarkButton label="Italic" active={activeMarks.italic} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></MarkButton>
          <MarkButton label="Underline" active={activeMarks.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline size={15} /></MarkButton>
          <MarkButton label="Strikethrough" active={activeMarks.strike} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={15} /></MarkButton>
          <MarkButton label="Inline code" active={activeMarks.code} onClick={() => editor.chain().focus().toggleCode().run()}><Code size={15} /></MarkButton>
          <span className="formatting-divider" />
          <MarkButton label="Set link" active={activeMarks.link} onClick={openLinkEditor}><LinkIcon size={15} /></MarkButton>
          {activeMarks.link && (
            <MarkButton label="Remove link" active={false} onClick={() => editor.chain().focus().unsetLink().run()}><Unlink size={15} /></MarkButton>
          )}
        </>
      )}
    </BubbleMenu>
  )
}
