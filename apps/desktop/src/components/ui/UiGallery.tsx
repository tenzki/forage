import { useState, type ReactNode } from 'react'
import { Download, EyeOff, Plus, Puzzle, Sparkles, Trash2, Clock3, Link2 } from 'lucide-react'
import { ForageLockup } from '../ForageMark'
import { ActivitySidebar, type ActivityCall } from '../Agent/ActivitySidebar'
import { LinkPreviewCard, type LinkPreviewActions, type LinkPreviewModel } from '../Outliner/LinkPreviewCard'
import { AgentProvenance } from './AgentProvenance'
import { AlertBanner } from './AlertBanner'
import { Button } from './Button'
import { Callout } from './Callout'
import { CountBadge } from './CountBadge'
import { EmptyState } from './EmptyState'
import { Field, Input, Select, Textarea } from './Field'
import { FilterChip } from './FilterChip'
import { IconButton } from './IconButton'
import { Kbd } from './Kbd'
import { DefinitionRow, ListRow } from './ListRow'
import { ResultRow } from './ResultRow'
import { SectionHeader } from './SectionHeader'
import { SegmentedControl } from './SegmentedControl'
import { StatusPill } from './StatusPill'
import { Switch } from './Switch'
import { SwitchFieldInput } from './SwitchFieldInput'
import { Tag } from './Tag'

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-mono text-[10px] tracking-[0.08em] text-moss uppercase">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  )
}

const now = Date.now()
const minutes = (count: number) => now - count * 60_000

const SAMPLE_CALLS: ActivityCall[] = [
  {
    id: 'run-1', kind: 'skill', label: 'Run /research spaced repetition', detail: 'spaced repetition', nodeId: 'next',
    status: 'complete', timestamp: minutes(40), durationMs: 14_200,
    events: [
      { id: 's1', kind: 'tool', label: 'web_search', detail: 'query: spaced repetition retention studies', status: 'complete', timestamp: minutes(40), durationMs: 600 },
      { id: 's2', kind: 'tool', label: 'web_search', detail: 'query: leitner system vs sm-2', status: 'complete', timestamp: minutes(40), durationMs: 700 },
      { id: 'r1', kind: 'tool', label: 'web_fetch', detail: 'url: https://www.pnas.org/doi/optimising-review-schedules', status: 'complete', timestamp: minutes(39), durationMs: 2_400 },
      { id: 'r2', kind: 'tool', label: 'web_fetch', detail: 'url: https://gwern.net/spaced-repetition', status: 'complete', timestamp: minutes(39), durationMs: 3_100 },
      { id: 'o1', kind: 'output', label: 'Open result', nodeId: 'gone', status: 'complete', timestamp: minutes(38) },
    ],
  },
  {
    id: 'run-2', kind: 'skill', label: 'Run /research spaced repetition', detail: 'spaced repetition', nodeId: 'next',
    note: 'One bullet per technique, with sources.', status: 'running', timestamp: minutes(2),
    events: [
      { id: 'r3', kind: 'tool', label: 'web_fetch', detail: 'url: https://ncase.me/remember/', status: 'running', timestamp: minutes(1) },
    ],
  },
  {
    id: 'run-3', kind: 'skill', label: 'Run /image lavender sprig', detail: 'lavender sprig', nodeId: 'garden',
    status: 'error', timestamp: minutes(90), durationMs: 3_000, events: [],
  },
  { id: 'cmd-1', kind: 'command', label: '/todo', nodeId: 'garden', status: 'complete', timestamp: minutes(24 * 60 + 5), events: [] },
]

const SAMPLE_NODES: Record<string, { title: string; bulletCount: number }> = {
  next: { title: 'Next steps', bulletCount: 4 },
  garden: { title: 'A garden of ideas', bulletCount: 12 },
}

const PREVIEWS: LinkPreviewModel[] = [
  { kind: 'internal', targetId: 'garden', path: ['Notes', 'Thinking spaces'], title: 'A garden of ideas', children: ['Ideas grow when revisited, not when filed', 'Prune: archive branches untouched for 90 days', 'Every note answers one question'], moreCount: 6, backlinkCount: 3 },
  { kind: 'external', href: 'https://zettelkasten.de/introduction/', host: 'zettelkasten.de', status: 'ready', title: 'Introduction to the Zettelkasten Method', description: 'A principle-based approach to note-taking: atomic notes, dense links, and a structure that grows from the bottom up.' },
  { kind: 'missing', label: 'Old reading plan' },
  { kind: 'external', href: 'https://old-blog.example.com/2019/notes-on-notes', host: 'old-blog.example.com', status: 'error' },
]

const NO_ACTIONS: LinkPreviewActions = {
  onPeek: () => undefined, onOpenExternal: () => undefined, onRetry: () => undefined,
  onOpenInternal: () => undefined, onRelink: () => undefined, onRemoveLink: () => undefined,
}

/**
 * Development-only catalogue of the shared UI components, opened at `#ui-kit`.
 * Mirrors the component board in docs/desktop.pen.
 */
export function UiGallery() {
  const [toggle, setToggle] = useState(true)
  const [chip, setChip] = useState('all')
  const [mode, setMode] = useState<'local' | 'server'>('local')
  return (
    <main className="min-h-screen overflow-auto bg-paper px-10 py-10 font-sans text-ink">
      <div className="mx-auto flex max-w-[880px] flex-col gap-9">
        <div className="flex items-center justify-between">
          <ForageLockup />
          <span className="font-mono text-[10px] text-moss">UI kit · docs/desktop.pen</span>
        </div>

        <Group title="Buttons">
          <Button variant="primary" icon={<Plus />}>New bullet</Button>
          <Button icon={<Download />}>Export</Button>
          <Button variant="ghost" icon={<EyeOff />}>Hide completed</Button>
          <Button variant="danger" icon={<Trash2 />}>Delete forever</Button>
          <Button variant="agent" icon={<Sparkles />}>Place here</Button>
          <Button variant="add" icon={<Plus />}>Add skill</Button>
          <Button size="sm">Edit</Button>
          <Button size="sm" variant="danger">Remove</Button>
          <Button variant="primary" disabled>Disabled</Button>
        </Group>

        <Group title="Icon buttons">
          <IconButton label="Links"><Link2 size={15} /></IconButton>
          <IconButton label="Links" active><Link2 size={15} /></IconButton>
        </Group>

        <Group title="Badges">
          <Tag>#reading</Tag>
          <CountBadge>4</CountBadge>
          <Kbd>⌘K</Kbd>
          <AgentProvenance skill="research" />
          <StatusPill tone="running">Running</StatusPill>
          <StatusPill tone="success">Done</StatusPill>
          <StatusPill tone="danger">Failed</StatusPill>
          <StatusPill tone="success" icon={false}>Enabled</StatusPill>
          <StatusPill tone="danger" icon={false}>Needs review</StatusPill>
          <StatusPill tone="muted" icon={false}>Disabled</StatusPill>
        </Group>

        <Group title="Controls">
          <Switch checked={toggle} onCheckedChange={setToggle} aria-label="Toggle" />
          <Switch checked={!toggle} onCheckedChange={(next) => setToggle(!next)} aria-label="Toggle off" />
          <SegmentedControl
            ariaLabel="Mode"
            value={mode}
            onValueChange={setMode}
            options={[{ value: 'local', label: 'Local' }, { value: 'server', label: 'Server' }]}
          />
          {['all', 'todos', 'open'].map((value) => (
            <FilterChip key={value} active={chip === value} onClick={() => setChip(value)}>
              {value === 'all' ? 'All' : value === 'todos' ? 'Todos' : 'Open todos'}
            </FilterChip>
          ))}
        </Group>

        <Group title="Fields">
          <div className="grid w-full grid-cols-3 gap-4">
            <Field label="Default model"><Input mono defaultValue="gpt-5-codex" /></Field>
            <Field label="Agent" hint="Runs this skill."><Select><option>Researcher</option><option>Writer</option></Select></Field>
            <Field label="Origin" error="Use an https:// origin."><Input defaultValue="http://" aria-invalid /></Field>
            <div className="col-span-3"><Field label="Instructions"><Textarea placeholder="Describe the workflow…" /></Field></div>
          </div>
        </Group>

        <Group title="Notices">
          <Callout tone="caution" title="Extensions are trusted local code"><p>Review the manifest and source before enabling.</p></Callout>
          <Callout tone="info" title="Local execution only."><p>Forage will not fall back to this device.</p></Callout>
          <AlertBanner title="Agent error" description="The runtime stopped before it finished. Try again." onDismiss={() => undefined} />
        </Group>

        <section className="flex flex-col gap-4">
          <SectionHeader title="Skills" description="Choose an LLM agent or an installed extension executor." actions={<Button size="sm">Install</Button>} />
          <div className="overflow-hidden rounded-[10px] border border-rule-soft">
            <ListRow title="/research" description="Investigate a topic and structure findings as notes" meta="Researcher" actions={<><Button size="sm">Edit</Button><Button size="sm" variant="danger">Remove</Button></>} />
            <SwitchFieldInput label="Web search" hint="Search DuckDuckGo for current information and sources." checked={toggle} onCheckedChange={setToggle} />
            <ListRow leading={<Puzzle />} title="Text Stats" description="0.1.0 · Local folder" meta="1 tool · 1 executor · 2 hooks" status={<StatusPill tone="success" icon={false}>Enabled</StatusPill>} onClick={() => undefined} />
          </div>
          <dl className="m-0 flex flex-col">
            <DefinitionRow term="Identity">app.forage.system-one</DefinitionRow>
            <DefinitionRow term="Source" mono={false}>Local folder</DefinitionRow>
          </dl>
          <div>
            <ResultRow state="ok" title="Node.js is available" detail="v22.11.0" />
            <ResultRow state="error" title="Codex CLI was not found" />
            <ResultRow state="unchecked" title="Node.js not checked" />
            <ResultRow state="error" title="Codex is unavailable" error="spawn codex ENOENT — install Codex 0.148.0+ and make sure it is on PATH." />
          </div>
        </section>

        <Group title="Link previews">
          <div className="grid grid-cols-2 items-start gap-4">
            {PREVIEWS.map((model, index) => (
              <div key={index} className={`link-card is-${model.kind}${model.kind === 'external' ? ` is-${model.status}` : ''}`} style={{ position: 'static', width: 340 }}>
                <LinkPreviewCard model={model} actions={NO_ACTIONS} />
              </div>
            ))}
          </div>
        </Group>

        <Group title="Activity">
          <div className="flex h-[640px] w-[320px] border border-rule-soft [&>aside]:w-full">
            <ActivitySidebar
              calls={SAMPLE_CALLS}
              onClear={() => undefined}
              onOpenNode={() => undefined}
              describeNode={(nodeId) => SAMPLE_NODES[nodeId] ?? null}
              canSteer={() => true}
              onSteer={() => undefined}
              canCancel={() => true}
              onCancel={() => undefined}
            />
          </div>
        </Group>

        <Group title="Empty state">
          <div className="w-72 rounded-[10px] border border-rule-soft bg-paper-raised">
            <EmptyState icon={<Clock3 />} title="No activity yet" description="Run a skill to see its work here." />
          </div>
        </Group>
      </div>
    </main>
  )
}
