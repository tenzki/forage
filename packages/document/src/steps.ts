import { Slice, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model'
import { ReplaceStep, Step, Transform } from '@tiptap/pm/transform'

export type SerializedStep = Record<string, unknown>

export interface SerializedStepBatch {
  steps: SerializedStep[]
  /** Stored in the order in which undo applies them. */
  inverseSteps: SerializedStep[]
}

export function captureStepBatch(
  before: ProseMirrorNode,
  steps: readonly Step[],
): SerializedStepBatch {
  let doc = before
  const inverseSteps: SerializedStep[] = []
  const serialized: SerializedStep[] = []
  for (const step of steps) {
    const inverse = step.invert(doc)
    const result = step.apply(doc)
    if (result.failed || !result.doc) {
      throw new Error(`Cannot capture invalid ProseMirror step: ${result.failed ?? 'no document'}`)
    }
    serialized.push(step.toJSON() as SerializedStep)
    inverseSteps.unshift(inverse.toJSON() as SerializedStep)
    doc = result.doc
  }
  return { steps: serialized, inverseSteps }
}

export function deserializeStep(schema: Schema, value: SerializedStep): Step {
  return Step.fromJSON(schema, value)
}

export function applySerializedSteps(
  document: ProseMirrorNode,
  steps: readonly SerializedStep[],
): ProseMirrorNode {
  const transform = new Transform(document)
  for (const serialized of steps) transform.step(deserializeStep(document.type.schema, serialized))
  return transform.doc
}

export interface RebasedStepBatch extends SerializedStepBatch {
  doc: ProseMirrorNode
}

/** Build the smallest single replace step that changes one valid document into another. */
export function documentChangeSteps(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
): SerializedStep[] {
  const start = before.content.findDiffStart(after.content)
  if (start === null) return []
  const end = before.content.findDiffEnd(after.content)
  if (!end) return []
  const step = new ReplaceStep(start, end.a, after.slice(start, end.b))
  const serialized = step.toJSON() as SerializedStep
  try {
    if (applySerializedSteps(before, [serialized]).eq(after)) return [serialized]
  } catch {
    // Some structural slices only retain their open depths in memory. A
    // serialized migration must instead use a closed document replacement.
  }
  const replacement = new ReplaceStep(0, before.content.size, new Slice(after.content, 0, 0))
  const replacementJson = replacement.toJSON() as SerializedStep
  const result = applySerializedSteps(before, [replacementJson])
  if (!result.eq(after)) throw new Error('Cannot derive a safe document change step: result differs')
  return [replacementJson]
}

/** Rebase unaccepted local steps over accepted remote steps using ProseMirror mappings. */
export function rebaseSerializedSteps(
  base: ProseMirrorNode,
  local: SerializedStepBatch,
  remote: readonly SerializedStep[],
): RebasedStepBatch {
  const schema = base.type.schema
  const localSteps = local.steps.map((step) => deserializeStep(schema, step))
  const localDocument = applySerializedSteps(base, local.steps)
  const transform = new Transform(localDocument)

  for (const inverse of local.inverseSteps) transform.step(deserializeStep(schema, inverse))
  for (const step of remote) transform.step(deserializeStep(schema, step))

  let mapFrom = localSteps.length
  const rebasedSteps: SerializedStep[] = []
  const rebasedInverseSteps: SerializedStep[] = []
  for (const step of localSteps) {
    const mapped = step.map(transform.mapping.slice(mapFrom))
    mapFrom -= 1
    if (!mapped) continue
    const inverse = mapped.invert(transform.doc)
    const result = transform.maybeStep(mapped)
    if (result.failed) continue
    // setMirror is present in prosemirror-transform at runtime and used by its
    // collab package, but is accidentally omitted from the distributed Mapping declaration.
    ;(transform.mapping as typeof transform.mapping & { setMirror: (left: number, right: number) => void })
      .setMirror(mapFrom, transform.steps.length - 1)
    rebasedSteps.push(mapped.toJSON() as SerializedStep)
    rebasedInverseSteps.unshift(inverse.toJSON() as SerializedStep)
  }

  return { doc: transform.doc, steps: rebasedSteps, inverseSteps: rebasedInverseSteps }
}

export interface NormalizedBulletIds {
  doc: ProseMirrorNode
  steps: SerializedStep[]
}

export function normalizeStableBulletIds(
  document: ProseMirrorNode,
  nextId: () => string,
): NormalizedBulletIds {
  const transform = new Transform(document)
  const seen = new Set<string>()
  document.descendants((node, pos) => {
    if (node.type.name !== 'listItem') return
    const id = typeof node.attrs.nodeId === 'string' ? node.attrs.nodeId : ''
    if (id && !seen.has(id)) {
      seen.add(id)
      return
    }
    const replacement = nextId()
    if (!replacement || seen.has(replacement)) throw new Error('Stable bullet id source returned a duplicate or empty id')
    transform.setNodeMarkup(pos, undefined, { ...node.attrs, nodeId: replacement })
    seen.add(replacement)
  })
  return {
    doc: transform.doc,
    steps: transform.steps.map((step) => step.toJSON() as SerializedStep),
  }
}
