import {
  CONTEXT_PRESET_OPTIONS,
  contextStrategyForPreset,
  type ContextSelector,
  type SkillContextStrategy,
} from '../../agent/definitions'

interface Props {
  value: SkillContextStrategy
  onChange: (value: SkillContextStrategy) => void
}

function selectorOf<K extends ContextSelector['kind']>(
  strategy: SkillContextStrategy,
  kind: K,
): Extract<ContextSelector, { kind: K }> | undefined {
  return strategy.selectors.find((selector) => selector.kind === kind) as
    Extract<ContextSelector, { kind: K }> | undefined
}

function depthValue(value: string): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(20, Math.max(1, parsed)) : undefined
}

export function SkillContextSettings({ value, onChange }: Props) {
  const custom = (next: Partial<SkillContextStrategy>) => onChange({ ...value, ...next, preset: 'custom' })
  const replaceSelector = (next: ContextSelector) => custom({
    selectors: value.selectors.map((selector) => selector.kind === next.kind ? next : selector),
  })
  const toggleSelector = (selector: ContextSelector, enabled: boolean) => custom({
    selectors: enabled
      ? [...value.selectors, selector]
      : value.selectors.filter((candidate) => candidate.kind !== selector.kind),
  })
  const self = selectorOf(value, 'self')
  const ancestors = selectorOf(value, 'ancestors')
  const descendants = selectorOf(value, 'descendants')
  const siblings = selectorOf(value, 'siblings')

  return (
    <fieldset className="skill-context-settings">
      <legend>Automatic context</legend>
      <p className="settings-hint">Selected nodes change color while the slash command is composed and focused.</p>
      <label>Strategy preset
        <select
          aria-label="Context strategy preset"
          value={value.preset}
          onChange={(event) => {
            if (event.target.value === 'custom') return
            onChange(contextStrategyForPreset(event.target.value as Exclude<SkillContextStrategy['preset'], 'custom'>))
          }}
        >
          {CONTEXT_PRESET_OPTIONS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          <option value="custom">Custom</option>
        </select>
      </label>
      <label>Context root
        <select aria-label="Context root" value={value.anchor} onChange={(event) => custom({ anchor: event.target.value as SkillContextStrategy['anchor'] })}>
          <option value="invocation">Command bullet</option>
          <option value="parent">Parent of command</option>
          <option value="previousSibling">Previous sibling of command</option>
        </select>
      </label>

      <div className="context-selector-grid">
        <label><input type="checkbox" checked={Boolean(self)} onChange={(event) => toggleSelector({ kind: 'self' }, event.target.checked)} />Context root itself</label>
        <label><input type="checkbox" checked={Boolean(ancestors)} onChange={(event) => toggleSelector({ kind: 'ancestors' }, event.target.checked)} />Ancestors</label>
        {ancestors && <label>Ancestor depth<input aria-label="Ancestor depth" type="number" min="1" max="20" placeholder="All" value={ancestors.maxDepth ?? ''} onChange={(event) => replaceSelector({ kind: 'ancestors', ...(depthValue(event.target.value) ? { maxDepth: depthValue(event.target.value) } : {}) })} /></label>}
        <label><input type="checkbox" checked={Boolean(descendants)} onChange={(event) => toggleSelector({ kind: 'descendants' }, event.target.checked)} />Descendants</label>
        {descendants && <label>Descendant depth<input aria-label="Descendant depth" type="number" min="1" max="20" placeholder="All" value={descendants.maxDepth ?? ''} onChange={(event) => replaceSelector({ kind: 'descendants', ...(depthValue(event.target.value) ? { maxDepth: depthValue(event.target.value) } : {}) })} /></label>}
        <label><input type="checkbox" checked={Boolean(siblings)} onChange={(event) => toggleSelector({ kind: 'siblings', position: 'both', includeSubtrees: false }, event.target.checked)} />Siblings</label>
      </div>

      {siblings && <div className="context-sibling-options">
        <label>Sibling position<select aria-label="Sibling position" value={siblings.position} onChange={(event) => replaceSelector({ ...siblings, position: event.target.value as typeof siblings.position })}><option value="both">Before and after</option><option value="before">Before only</option><option value="after">After only</option></select></label>
        <label><input type="checkbox" checked={siblings.includeSubtrees} onChange={(event) => replaceSelector({ ...siblings, includeSubtrees: event.target.checked })} />Include sibling branches</label>
        {siblings.includeSubtrees && <label>Sibling branch depth<input aria-label="Sibling branch depth" type="number" min="1" max="20" placeholder="All" value={siblings.maxDepth ?? ''} onChange={(event) => replaceSelector({ ...siblings, maxDepth: depthValue(event.target.value) })} /></label>}
      </div>}

      <div className="context-selector-grid">
        <label><input type="checkbox" checked={value.filters.excludeInvocation} onChange={(event) => custom({ filters: { ...value.filters, excludeInvocation: event.target.checked } })} />Exclude command bullet</label>
        <label><input type="checkbox" checked={value.filters.includeAiNodes} onChange={(event) => custom({ filters: { ...value.filters, includeAiNodes: event.target.checked } })} />Include AI nodes</label>
        <label><input type="checkbox" checked={value.filters.includeEmptyNodes} onChange={(event) => custom({ filters: { ...value.filters, includeEmptyNodes: event.target.checked } })} />Include empty nodes</label>
      </div>

      <div className="context-budget-grid">
        <label>Maximum nodes<input aria-label="Maximum context nodes" type="number" min="1" max="500" value={value.budget.maxNodes} onChange={(event) => custom({ budget: { ...value.budget, maxNodes: Number(event.target.value) } })} /></label>
        <label>Maximum characters<input aria-label="Maximum context characters" type="number" min="100" max="200000" value={value.budget.maxCharacters} onChange={(event) => custom({ budget: { ...value.budget, maxCharacters: Number(event.target.value) } })} /></label>
        <label>When limit is exceeded<select aria-label="Context overflow behavior" value={value.budget.overflow} onChange={(event) => custom({ budget: { ...value.budget, overflow: event.target.value as 'block' | 'truncate' } })}><option value="truncate">Truncate deterministically</option><option value="block">Block and report an error</option></select></label>
      </div>
    </fieldset>
  )
}
