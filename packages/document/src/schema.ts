import { Extension, Mark, Node, getSchema, mergeAttributes } from '@tiptap/core'
import BulletList from '@tiptap/extension-bullet-list'
import StarterKit from '@tiptap/starter-kit'
import type { Schema } from '@tiptap/pm/model'

export const StableBulletAttributes = Extension.create({
  name: 'stableBulletAttributes',

  addGlobalAttributes() {
    return [{
      types: ['listItem'],
      attributes: {
        nodeId: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-node-id'),
          renderHTML: (attrs) => attrs.nodeId ? { 'data-node-id': attrs.nodeId } : {},
        },
        nodeType: {
          default: 'user',
          parseHTML: (element) => element.getAttribute('data-node-type') ?? 'user',
          renderHTML: (attrs) => ({ 'data-node-type': attrs.nodeType ?? 'user' }),
        },
        collapsed: {
          default: false,
          parseHTML: (element) => element.getAttribute('data-collapsed') === 'true',
          renderHTML: (attrs) => attrs.collapsed ? { 'data-collapsed': 'true' } : {},
        },
        bulletKind: {
          default: 'bullet',
          parseHTML: (element) => element.getAttribute('data-bullet-kind') === 'todo' ? 'todo' : 'bullet',
          renderHTML: (attrs) => attrs.bulletKind === 'todo' ? { 'data-bullet-kind': 'todo' } : {},
        },
        completed: {
          default: false,
          parseHTML: (element) => element.getAttribute('data-completed') === 'true',
          renderHTML: (attrs) => attrs.completed ? { 'data-completed': 'true' } : {},
        },
      },
    }]
  },
})

export const OutlineBulletListSchema = BulletList.extend({
  content: '(listItem | generatedImageItem)+',
})

export const BulletNoteSchema = Node.create({
  name: 'bulletNote',
  group: 'block',
  content: 'inline*',
  defining: true,
  priority: 1_100,
  parseHTML: () => [{ tag: 'div[data-bullet-note]' }],
  renderHTML: () => ['div', { 'data-bullet-note': '', class: 'bullet-note' }, 0],
})

export const InternalLinkSchema = Mark.create({
  name: 'internalLink',
  priority: 1_100,
  inclusive: false,
  addAttributes: () => ({
    targetId: {
      default: null,
      parseHTML: (element) => element.getAttribute('data-internal-node-id'),
    },
  }),
  parseHTML: () => [{ tag: 'a[data-internal-node-id]' }],
  renderHTML({ HTMLAttributes }) {
    const targetId = String(HTMLAttributes.targetId ?? '')
    return ['a', mergeAttributes(HTMLAttributes, {
      class: 'internal-link',
      'data-internal-node-id': targetId,
      href: `#node=${encodeURIComponent(targetId)}`,
    }), 0]
  },
})

export const GeneratedImageItemSchema = Node.create({
  name: 'generatedImageItem',
  priority: 110,
  content: 'generatedImage',
  defining: true,
  isolating: true,
  selectable: true,
  parseHTML: () => [{ tag: 'li[data-generated-image-item]' }],
  renderHTML: ({ HTMLAttributes }) => ['li', mergeAttributes(HTMLAttributes, {
    'data-generated-image-item': 'true',
    'data-node-type': 'image',
  }), 0],
})

export const GeneratedImageSchema = Node.create({
  name: 'generatedImage',
  atom: true,
  selectable: true,
  addAttributes: () => ({ assetId: { default: '' }, alt: { default: '' } }),
  parseHTML: () => [{ tag: 'img[data-ai-generated-image]' }],
  renderHTML: ({ HTMLAttributes }) => ['img', mergeAttributes({ alt: HTMLAttributes.alt }, {
    'data-ai-generated-image': 'true',
    'data-asset-id': HTMLAttributes.assetId,
    'data-asset-state': 'loading',
    contenteditable: 'false',
    draggable: 'false',
  })],
})

export function outlineSchemaExtensions() {
  return [
    StarterKit.configure({ bulletList: false, trailingNode: false }),
    OutlineBulletListSchema,
    GeneratedImageItemSchema,
    GeneratedImageSchema,
    StableBulletAttributes,
    BulletNoteSchema,
    InternalLinkSchema,
  ]
}

let cachedSchema: Schema | null = null

export function createOutlineSchema(): Schema {
  cachedSchema ??= getSchema(outlineSchemaExtensions())
  return cachedSchema
}
