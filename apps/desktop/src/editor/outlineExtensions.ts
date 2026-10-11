import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes, OutlinerKeymap } from './extensions'
import { BulletNote } from './bulletNote'
import { SkillContextPreview } from './contextPreview'
import { GeneratedImage, GeneratedImageItem, OutlineBulletList, OutlineListItem } from './generatedImage'
import { InternalLink } from './internalLinks'
import { ExternalLink } from './externalLinks'
import { LinkCards } from './linkCard'
import { OutlinerUi } from './outlinerUi'
import { TagDecorations } from './tags'
import { SlashCommandDecorations } from './slashCommands'
import { AgentStreamingText } from './agentStreamingText'

// Schema attributes are present in all views; document admission and identity
// normalization belong exclusively to the canonical editor.
const ViewBulletAttributes = BulletAttributes.extend({ addProseMirrorPlugins: () => [] })
export function outlineExtensions(canonical = false) {
  return [
    StarterKit.configure({ bulletList: false, listItem: false, trailingNode: false,
      undoRedo: false, link: { openOnClick: false } }),
    OutlineListItem, OutlineBulletList, GeneratedImageItem, GeneratedImage,
    canonical ? BulletAttributes : ViewBulletAttributes,
    BulletNote, InternalLink, ExternalLink, LinkCards,
    OutlinerUi.configure({ renderDecorations: !canonical }), AgentStreamingText,
    ...(!canonical ? [OutlinerKeymap, TagDecorations, SlashCommandDecorations, SkillContextPreview] : []),
  ]
}
