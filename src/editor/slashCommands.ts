import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { SKILLS } from '../agent/skills'

const commandPluginKey = new PluginKey('outlineSlashCommands')
const commandPattern = /^\/([\p{L}\p{N}_-]+)/u
const skillLabels = new Set(SKILLS.map((skill) => skill.label))

function commandDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return
    const match = commandPattern.exec(node.textContent)
    if (!match || !skillLabels.has(match[1])) return
    const command = `/${match[1]}`
    decorations.push(Decoration.inline(pos + 1, pos + 1 + command.length, {
      class: 'outline-command',
      'data-command': match[1],
    }))
  })
  return DecorationSet.create(doc, decorations)
}

export const SlashCommandDecorations = Extension.create({
  name: 'slashCommandDecorations',

  addProseMirrorPlugins() {
    return [new Plugin({
      key: commandPluginKey,
      state: {
        init: (_, state) => commandDecorations(state.doc),
        apply: (transaction, previous) => transaction.docChanged
          ? commandDecorations(transaction.doc)
          : previous.map(transaction.mapping, transaction.doc),
      },
      props: {
        decorations: (state) => commandPluginKey.getState(state),
      },
    })]
  },
})
