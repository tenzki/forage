import { describe, expect, it } from 'vitest'
import {
  prepareSystemOneInput,
  requirePreparedSystemOneData,
  requireSystemOneConfiguration,
} from '../src/index.js'
import { baseConfiguration, contextSnapshot } from './fixtures.js'

describe('System One candidate preparation', () => {
  it('selects direct siblings in document order and keeps subtree, ancestor, and linked evidence distinct', () => {
    const plan = prepareSystemOneInput(requireSystemOneConfiguration(baseConfiguration), contextSnapshot)
    const data = requirePreparedSystemOneData(plan.data)

    expect(plan.selectedNodeIds).toEqual(['idea-a', 'idea-b'])
    expect(plan.requestedReferenceIds).toEqual(['idea-a', 'idea-b'])
    expect(data.candidates[0]?.evidence.map((entry) => entry.id)).toEqual(['evidence-a'])
    expect(data.sharedEvidence.map((entry) => [entry.id, entry.provenance])).toEqual([
      ['root', 'ancestor'], ['parent', 'ancestor'],
      ['constraints', 'explicit-link'], ['constraint-one', 'explicit-link'],
    ])
    expect(plan.selectedNodeIds).not.toContain('constraints')
    expect(plan.annotations).toEqual(expect.arrayContaining([
      { nodeId: 'idea-a', kind: 'selected', label: 'System One candidate (subtree evidence)' },
      { nodeId: 'evidence-a', kind: 'information', label: 'Evidence for Offline capture' },
      { nodeId: 'constraints', kind: 'shared', label: 'Shared linked evidence' },
    ]))
  })

  it('selects every nonempty descendant in stable document order without expanding explicit links', () => {
    const configuration = requireSystemOneConfiguration({
      ...baseConfiguration,
      candidate_scope: 'descendants',
    })
    const plan = prepareSystemOneInput(configuration, contextSnapshot)
    expect(plan.selectedNodeIds).toEqual(['idea-a', 'evidence-a', 'idea-b'])
    expect(plan.selectedNodeIds).not.toContain('constraints')
    expect(JSON.stringify(plan)).not.toContain('invoke')
  })

  it('fails before evaluation for no candidates or too few comparison choices', () => {
    const empty = {
      ...contextSnapshot,
      roots: [{ id: 'parent', text: 'Parent', documentOrder: 0 }],
      provenance: { ancestorPathIds: ['parent'], localParentId: 'parent', localBranchRootId: 'parent', explicitLinkedRootIds: [] },
    }
    expect(() => prepareSystemOneInput(requireSystemOneConfiguration(baseConfiguration), empty)).toThrow(/no text candidates/i)

    const one = {
      ...contextSnapshot,
      roots: [{ id: 'parent', text: 'Parent', documentOrder: 0, children: [{ id: 'only', text: 'Only', documentOrder: 1 }] }],
      provenance: { ancestorPathIds: ['parent'], localParentId: 'parent', localBranchRootId: 'parent', explicitLinkedRootIds: [] },
    }
    expect(() => prepareSystemOneInput(requireSystemOneConfiguration({
      ...baseConfiguration, kind: 'choice-comparison',
    }), one)).toThrow(/at least two candidates/i)
  })
})
