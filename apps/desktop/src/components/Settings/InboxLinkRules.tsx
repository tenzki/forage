import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, GripVertical, MoreHorizontal, Trash2, X } from 'lucide-react'
import { z } from 'zod'
import { automationPolicySetSchema, normalizeSiteDomain, type AutomationPolicySet } from '@forage/protocol'
import { ComboboxFieldInput } from '../ui/ComboboxFieldInput'
import { DropdownMenu, DropdownMenuItem } from '../ui/DropdownMenu'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Switch } from '../ui/Switch'
import { SwitchFieldInput } from '../ui/SwitchFieldInput'
import { Button } from '../ui/Button'
import { Input } from '../ui/Field'

type AutomationPolicy = AutomationPolicySet['policies'][number]
type SkillOption = { id: string; label: string }

export interface InboxLinkRulesTransport {
  automation(): Promise<unknown>
  publishAutomation(request: unknown): Promise<unknown>
}

interface InboxLinkRulesProps {
  skills: SkillOption[]
  transport: InboxLinkRulesTransport
  canPublish: boolean
}

// Site and any-link rules are fully editable; other policies published through the API keep their match
// and dispatcher verbatim, while their name, enabled state, and (without a dispatcher) skills stay editable.
type RuleRow =
  | { kind: 'site' | 'any'; id: string; name: string; enabled: boolean; sites: string[]; skillIds: string[] }
  | { kind: 'advanced'; id: string; policy: AutomationPolicy }

type RuleFields = { name: string; enabled: boolean; skillIds: string[] }

interface DragState { id: string; offsetY: number; dropIndex: number }
interface MenuState { id: string; top: number; left: number; trigger: HTMLButtonElement }

const ANY_LINK_TYPES = ['youtube', 'x', 'webpage'] as const
const URL_TYPE_LABELS: Record<(typeof ANY_LINK_TYPES)[number], string> = { youtube: 'YouTube', x: 'X', webpage: 'Web page' }
const MAX_SITES = 20
const MAX_SKILLS = 20
const MAX_RULES = 100
const DRAG_THRESHOLD = 4
const MENU_WIDTH = 208
const publishedSchema = z.object({ policies: automationPolicySetSchema }).passthrough()
const automationResponseSchema = z.object({ published: publishedSchema.nullable() }).passthrough()

const defaultRules: RuleRow[] = [
  { kind: 'site', id: 'rule-github', name: 'GitHub', enabled: false, sites: ['github.com'], skillIds: [] },
  { kind: 'site', id: 'rule-youtube', name: 'YouTube', enabled: false, sites: ['youtube.com', 'youtu.be'], skillIds: [] },
  { kind: 'site', id: 'rule-x', name: 'X', enabled: false, sites: ['x.com', 'twitter.com'], skillIds: [] },
]

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function fields(row: RuleRow): RuleFields {
  return row.kind === 'advanced'
    ? { name: row.policy.name, enabled: row.policy.enabled, skillIds: row.policy.skillIds }
    : { name: row.name, enabled: row.enabled, skillIds: row.skillIds }
}

function withFields(row: RuleRow, update: Partial<RuleFields>): RuleRow {
  return row.kind === 'advanced' ? { ...row, policy: { ...row.policy, ...update } } : { ...row, ...update }
}

function skillsEditable(row: RuleRow): boolean {
  return row.kind !== 'advanced' || !row.policy.dispatcher.enabled
}

function describeMatch(policy: AutomationPolicy): string[] {
  const { match } = policy
  const parts: string[] = []
  if (match.urlTypes?.length) parts.push(`Link type: ${match.urlTypes.map((type) => URL_TYPE_LABELS[type]).join(', ')}`)
  if (match.urlHosts?.length) parts.push(`Sites: ${match.urlHosts.join(', ')}`)
  if (match.sourceKinds?.length) parts.push(`Source: ${match.sourceKinds.join(', ')}`)
  if (match.sourceEquals) parts.push(`Source fields: ${Object.entries(match.sourceEquals).map(([key, value]) => `${key}=${value}`).join(', ')}`)
  return parts
}

function rowFromPolicy(policy: AutomationPolicy): RuleRow {
  const { match } = policy
  const keys = Object.entries(match).filter(([, value]) => value !== undefined).map(([key]) => key)
  const editable = { id: policy.id, name: policy.name, enabled: policy.enabled, skillIds: [...policy.skillIds] }
  if (!policy.dispatcher.enabled && keys.length === 1) {
    if (match.urlHosts?.length) return { kind: 'site', ...editable, sites: [...match.urlHosts] }
    if (match.urlTypes?.length === ANY_LINK_TYPES.length && ANY_LINK_TYPES.every((type) => match.urlTypes!.includes(type))) {
      return { kind: 'any', ...editable, sites: [] }
    }
  }
  return { kind: 'advanced', id: policy.id, policy }
}

function policyFromRow(row: RuleRow, priority: number): AutomationPolicy {
  if (row.kind === 'advanced') return { ...row.policy, name: row.policy.name.trim(), priority }
  return {
    id: row.id, name: row.name.trim(), enabled: row.enabled, priority,
    match: row.kind === 'any' ? { urlTypes: [...ANY_LINK_TYPES] } : { urlHosts: row.sites },
    skillIds: row.skillIds, dispatcher: { enabled: false, allowedSkillIds: [] },
  }
}

function validationErrors(rows: RuleRow[]): string[] {
  const errors: string[] = []
  for (const row of rows) {
    const { name: rawName, skillIds } = fields(row)
    const name = rawName.trim()
    if (!name) { errors.push('Every rule needs a name.'); continue }
    if (row.kind === 'site' && row.sites.length === 0) errors.push(`${name} needs at least one site.`)
    if (skillIds.length === 0) errors.push(`${name} needs at least one skill.`)
  }
  return errors
}

function moveTo<T extends { id: string }>(rows: T[], id: string, gap: number): T[] {
  const from = rows.findIndex((row) => row.id === id)
  if (from < 0) return rows
  const to = gap > from ? gap - 1 : gap
  if (to === from) return rows
  const next = [...rows]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

export function InboxLinkRules({ skills, transport, canPublish }: InboxLinkRulesProps) {
  const reorderHintId = useId()
  const listRef = useRef<HTMLOListElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const focusHandleRef = useRef<string | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [baseRevision, setBaseRevision] = useState(0)
  const [enabled, setEnabled] = useState(false)
  const [rows, setRows] = useState<RuleRow[]>([])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [siteDrafts, setSiteDrafts] = useState<Record<string, string>>({})
  const [siteErrors, setSiteErrors] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<string[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  function applyPublished(policies: AutomationPolicySet | null) {
    setBaseRevision(policies?.revision ?? 0)
    setEnabled(policies?.enabled ?? false)
    setRows(policies ? policies.policies.map(rowFromPolicy) : defaultRules.map((row) => structuredClone(row)))
    setExpanded(new Set()); setSiteDrafts({}); setSiteErrors({}); setErrors([])
  }

  async function load() {
    setLoadState('loading'); setStatus(null); setConflict(false)
    try {
      const response = automationResponseSchema.parse(await transport.automation())
      applyPublished(response.published?.policies ?? null)
      setLoadState('ready')
    } catch (error) {
      setStatus(message(error))
      setLoadState('failed')
    }
  }

  useEffect(() => { void load() }, [])

  // Moving a keyed row re-inserts its DOM node, which drops focus; put it back on the handle.
  useEffect(() => {
    const id = focusHandleRef.current
    if (!id) return
    focusHandleRef.current = null
    const handles = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-rule-handle]') ?? []
    ;[...handles].find((handle) => handle.dataset.ruleHandle === id)?.focus()
  }, [rows])

  useEffect(() => {
    if (!menu) return
    // The menu is fixed to the viewport; don't let focusing it scroll the settings pane.
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node
      // The trigger toggles the menu itself on click.
      if (!menuRef.current?.contains(target) && !menu.trigger.contains(target)) setMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenu(null)
      menu.trigger.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menu])

  function updateRow(id: string, update: (row: RuleRow) => RuleRow) {
    setRows((current) => current.map((row) => row.id === id ? update(row) : row))
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  function addRule() {
    const id = `rule-${crypto.randomUUID()}`
    setRows((current) => [...current, { kind: 'site', id, name: 'New rule', enabled: false, sites: [], skillIds: [] }])
    setExpanded((current) => new Set(current).add(id))
  }

  function deleteRule(id: string) {
    setMenu(null)
    setRows((current) => current.filter((row) => row.id !== id))
  }

  function handleReorderKey(event: ReactKeyboardEvent<HTMLButtonElement>, id: string, index: number) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const to = event.key === 'ArrowUp' ? index - 1 : index + 1
    if (to < 0 || to >= rows.length) return
    focusHandleRef.current = id
    setRows((current) => moveTo(current, id, event.key === 'ArrowUp' ? to : to + 1))
    setAnnouncement(`${fields(rows[index]!).name} moved to position ${to + 1} of ${rows.length}.`)
  }

  // Pointer events rather than HTML5 drag and drop, which the Tauri webview intercepts.
  function startDrag(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0 || !listRef.current) return
    const midpoints = [...listRef.current.querySelectorAll<HTMLElement>('[data-rule-id]')]
      .map((element) => { const rect = element.getBoundingClientRect(); return rect.top + rect.height / 2 })
    const startY = event.clientY
    let current: DragState | null = null

    const move = (pointerEvent: PointerEvent) => {
      const offsetY = pointerEvent.clientY - startY
      if (!current && Math.abs(offsetY) < DRAG_THRESHOLD) return
      pointerEvent.preventDefault()
      if (!current) document.body.classList.add('is-dragging-rule')
      current = { id, offsetY, dropIndex: midpoints.filter((midpoint) => midpoint < pointerEvent.clientY).length }
      setDrag(current)
    }
    const finish = (commit: boolean) => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', drop)
      document.removeEventListener('pointercancel', cancel)
      document.removeEventListener('keydown', escape)
      document.body.classList.remove('is-dragging-rule')
      setDrag(null)
      if (commit && current) {
        const { dropIndex } = current
        setRows((rowsNow) => moveTo(rowsNow, id, dropIndex))
      }
      current = null
    }
    const drop = () => finish(true)
    const cancel = () => finish(false)
    const escape = (keyEvent: KeyboardEvent) => { if (keyEvent.key === 'Escape') finish(false) }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', drop)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('keydown', escape)
  }

  function addSite(row: Extract<RuleRow, { kind: 'site' | 'any' }>) {
    const draft = (siteDrafts[row.id] ?? '').trim()
    if (!draft) return
    const domain = normalizeSiteDomain(draft)
    const error = !domain ? `"${draft}" is not a valid site.`
      : row.sites.length >= MAX_SITES && !row.sites.includes(domain) ? `${row.name} can have at most ${MAX_SITES} sites.`
        : null
    setSiteErrors((current) => ({ ...current, [row.id]: error ?? '' }))
    if (error || !domain) return
    updateRow(row.id, (current) => current.kind === 'advanced' || current.sites.includes(domain)
      ? current : { ...current, sites: [...current.sites, domain] })
    setSiteDrafts((current) => ({ ...current, [row.id]: '' }))
  }

  async function publish() {
    const invalid = validationErrors(rows)
    setErrors(invalid); setStatus(null); setConflict(false)
    if (invalid.length) return
    setBusy(true)
    try {
      const policies: AutomationPolicySet = {
        version: 1, revision: baseRevision + 1, enabled,
        policies: rows.map((row, index) => policyFromRow(row, rows.length - index)),
      }
      const response = publishedSchema.parse(await transport.publishAutomation({ baseRevision, policies }))
      applyPublished(response.policies)
      setStatus('Inbox link rules published.')
    } catch (error) {
      if (/revision conflict/i.test(message(error))) setConflict(true)
      else setStatus(message(error))
    } finally { setBusy(false) }
  }

  const skillLabel = (skillId: string) => `/${skills.find((skill) => skill.id === skillId)?.label ?? skillId}`
  const ready = loadState === 'ready'
  const enabledCount = rows.filter((row) => fields(row).enabled).length
  const dragFrom = drag ? rows.findIndex((row) => row.id === drag.id) : -1
  const showDropLine = drag !== null && drag.dropIndex !== dragFrom && drag.dropIndex !== dragFrom + 1

  return (
    <div className="inbox-link-rules">
      <div className="inbox-link-rules-header">
        <strong>Inbox link rules</strong>
        {rows.length > 0 && <span className="settings-hint">{enabledCount} of {rows.length} enabled</span>}
      </div>
      <p className="settings-hint">Rules are checked top to bottom. Only the first matching rule runs its skills. A site also matches its subdomains.</p>
      <p id={reorderHintId} className="sr-only">Drag to reorder, or use the up and down arrow keys.</p>
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <ol ref={listRef} data-testid="inbox-link-rules" className="inbox-link-rule-list">{rows.map((row, index) => {
        const { name, enabled: ruleEnabled, skillIds } = fields(row)
        const isExpanded = expanded.has(row.id)
        const editorId = `${reorderHintId}-rule-${index}`
        const isDragSource = drag?.id === row.id
        const className = [
          'inbox-link-rule',
          isExpanded && 'is-expanded',
          !ruleEnabled && 'is-disabled',
          isDragSource && 'is-drag-source',
          showDropLine && drag!.dropIndex === index && 'is-drop-before',
          showDropLine && drag!.dropIndex === rows.length && index === rows.length - 1 && 'is-drop-after',
        ].filter(Boolean).join(' ')
        const matchSummary = row.kind === 'advanced' ? describeMatch(row.policy) : row.kind === 'any' ? ['Any link'] : row.sites

        return <li
          key={row.id}
          data-rule-id={row.id}
          className={className}
          style={isDragSource ? { transform: `translateY(${drag!.offsetY}px)` } : undefined}
        >
          <div className="inbox-link-rule-summary">
            <button
              type="button"
              className="inbox-link-rule-handle"
              data-rule-handle={row.id}
              aria-label={`Reorder ${name}`}
              aria-describedby={reorderHintId}
              disabled={!ready}
              onPointerDown={(event) => startDrag(event, row.id)}
              onKeyDown={(event) => handleReorderKey(event, row.id, index)}
            >
              <GripVertical size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="inbox-link-rule-open"
              aria-label={`Edit ${name}`}
              aria-expanded={isExpanded}
              aria-controls={editorId}
              onClick={() => toggleExpanded(row.id)}
            >
              <span className="inbox-link-rule-name">{name || 'Untitled rule'}</span>
              <span className="inbox-link-chips">
                {matchSummary.length === 0 && <span className="inbox-link-chip is-missing">No sites</span>}
                {matchSummary.map((part) => <span key={part} className="inbox-link-chip">{part}</span>)}
              </span>
              <ArrowRight size={12} aria-hidden="true" className="inbox-link-rule-arrow" />
              <span className="inbox-link-chips">
                {skillIds.length === 0 && <span className="inbox-link-chip is-missing">No skill</span>}
                {skillIds.map((skillId) => <span key={skillId} className="inbox-link-chip is-skill">{skillLabel(skillId)}</span>)}
              </span>
            </button>
            <Switch
              checked={ruleEnabled}
              aria-label={`Enable rule ${name}`}
              onCheckedChange={(checked) => updateRow(row.id, (current) => withFields(current, { enabled: checked }))}
            />
            <button
              type="button"
              className="inbox-link-rule-menu"
              aria-label={`Actions for ${name}`}
              aria-haspopup="menu"
              aria-expanded={menu?.id === row.id}
              onClick={(event) => {
                const trigger = event.currentTarget
                const rect = trigger.getBoundingClientRect()
                setMenu(menu?.id === row.id ? null : { id: row.id, top: rect.bottom + 4, left: Math.max(8, rect.right - MENU_WIDTH), trigger })
              }}
            >
              <MoreHorizontal size={14} aria-hidden="true" />
            </button>
          </div>
          {isExpanded && <div id={editorId} className="inbox-link-rule-editor">
            <label className="inbox-link-rule-field">
              <span>Name</span>
              <Input
                aria-label={`Rule name ${index + 1}`}
                value={name}
                maxLength={100}
                onChange={(event) => updateRow(row.id, (current) => withFields(current, { name: event.target.value }))}
              />
            </label>
            <div className="inbox-link-rule-field">
              <span>Match</span>
              {row.kind === 'advanced'
                ? <div>
                  <div className="inbox-link-chips">{matchSummary.map((part) => <span key={part} className="inbox-link-chip">{part}</span>)}</div>
                  <p className="settings-hint">This match was set through the API and can't be edited here.</p>
                </div>
                : <div className="inbox-link-rule-match">
                  <SegmentedControl
                    ariaLabel={`Match for ${name}`}
                    value={row.kind}
                    options={[{ value: 'site', label: 'Sites' }, { value: 'any', label: 'Any link' }]}
                    onValueChange={(kind) => updateRow(row.id, (current) => current.kind === 'advanced' ? current : { ...current, kind })}
                  />
                  {row.kind === 'site' && <div className="inbox-link-chips">
                    {row.sites.map((site) => <span key={site} className="inbox-link-chip is-removable">
                      {site}
                      <button
                        type="button"
                        aria-label={`Remove ${site} from ${name}`}
                        onClick={() => updateRow(row.id, (current) => current.kind === 'advanced'
                          ? current : { ...current, sites: current.sites.filter((candidate) => candidate !== site) })}
                      ><X size={10} aria-hidden="true" /></button>
                    </span>)}
                    <input
                      className="inbox-link-chip-input"
                      aria-label={`Add site to ${name}`}
                      placeholder="Add site, e.g. github.com"
                      autoComplete="off"
                      value={siteDrafts[row.id] ?? ''}
                      onChange={(event) => setSiteDrafts((current) => ({ ...current, [row.id]: event.target.value }))}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ',') return
                        event.preventDefault()
                        addSite(row)
                      }}
                    />
                  </div>}
                  {siteErrors[row.id] && <p role="alert" className="settings-error">{siteErrors[row.id]}</p>}
                </div>}
            </div>
            <div className="inbox-link-rule-field">
              <span>Skills</span>
              {skillsEditable(row)
                ? <div className="inbox-link-chips">
                  {skillIds.map((skillId) => <span key={skillId} className="inbox-link-chip is-skill is-removable">
                    {skillLabel(skillId)}
                    <button
                      type="button"
                      aria-label={`Remove ${skillLabel(skillId)} from ${name}`}
                      onClick={() => updateRow(row.id, (current) => withFields(current, {
                        skillIds: fields(current).skillIds.filter((candidate) => candidate !== skillId),
                      }))}
                    ><X size={10} aria-hidden="true" /></button>
                  </span>)}
                  {skills.length === 0
                    ? <p className="settings-hint">Publish agents and skills first.</p>
                    : skillIds.length < MAX_SKILLS && <ComboboxFieldInput
                      label={`Add skill to ${name}`}
                      hideLabel
                      clearOnSelect
                      value=""
                      placeholder="Add skill…"
                      emptyMessage="No more skills."
                      className="inbox-link-skill-picker"
                      options={skills.filter((skill) => !skillIds.includes(skill.id)).map((skill) => ({ value: skill.id, label: `/${skill.label}` }))}
                      onValueChange={(skillId) => updateRow(row.id, (current) => withFields(current, {
                        skillIds: [...fields(current).skillIds, skillId],
                      }))}
                    />}
                </div>
                : <div>
                  <div className="inbox-link-chips">{skillIds.map((skillId) => <span key={skillId} className="inbox-link-chip is-skill">{skillLabel(skillId)}</span>)}</div>
                  <p className="settings-hint">A dispatcher chooses among these skills; edit them through the API.</p>
                </div>}
            </div>
          </div>}
        </li>
      })}</ol>
      {/* Portaled: the settings panel's slide-in transform would otherwise anchor this fixed menu to the panel. */}
      {menu && createPortal(<DropdownMenu ref={menuRef} role="menu" aria-label="Rule actions" style={{ top: menu.top, left: menu.left }}>
        <DropdownMenuItem icon={Trash2} danger onClick={() => deleteRule(menu.id)}>Delete rule</DropdownMenuItem>
      </DropdownMenu>, document.body)}
      <Button disabled={!ready || rows.length >= MAX_RULES} onClick={addRule}>Add rule</Button>
      <SwitchFieldInput
        checked={enabled}
        disabled={!ready}
        label="Enable Inbox link automation"
        hint="Run the first matching rule's skills when a link reaches the Inbox."
        onCheckedChange={setEnabled}
      />
      {errors.map((error) => <p key={error} role="alert" className="settings-error">{error}</p>)}
      {conflict && <div role="alert" className="settings-error">
        <p>Rules changed on the server. Reload to continue.</p>
        <Button onClick={() => void load()}>Reload rules</Button>
      </div>}
      {status && <p className="settings-hint">{status}</p>}
      <Button variant="primary" disabled={!canPublish || !ready || busy} onClick={() => void publish()}>Publish link rules</Button>
    </div>
  )
}
