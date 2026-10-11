import { Puzzle } from 'lucide-react'
import { useSettingsNavigation } from './settingsNavigation'
import { SettingsBackLink } from './SettingsBackLink'
import { SkillForm } from './AgentEditors'
import { SwitchFieldInput } from '../ui/SwitchFieldInput'
import { usePublishedDraft } from './saveEditorDraft'
import { useEditorTools } from './useEditorTools'
import { configurationWithDefaults } from './ExtensionSkillConfigurationForm'
import { useDraftExit } from './useDraftExit'
import type { SkillDraft } from '../../agent/definitions'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { useEffect, useMemo, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import type {
  ExtensionCatalogEntry,
  ExtensionManagementResponse,
  ExtensionSettingDeclaration,
  ExtensionSourceRequest,
} from '@forage/agent-runtime'
import { nativeLocalCredentialVault } from '../../agent/localCredentials'
import {
  extensionConfigurationFor,
  extensionExecutorOptions,
  extensionToolOptions,
  statusLabel,
  useExtensionStore,
} from '../../store/extensionStore'
import { ConfirmButton } from './ConfirmButton'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Switch } from '../ui/Switch'
import { useSettingsStore } from '../../store/settingsStore'
import { Button } from '../ui/Button'
import { Callout } from '../ui/Callout'
import { CountBadge } from '../ui/CountBadge'
import { DefinitionRow, ListRow } from '../ui/ListRow'
import { StatusPill, type StatusTone } from '../ui/StatusPill'
import { Field, Input, Select, Textarea } from '../ui/Field'

const DIAGNOSTIC_COPY_LIMIT = 16_000
const SOURCE_KIND_OPTIONS = [
  { value: 'local', label: 'Local folder' },
  { value: 'npm', label: 'npm package' },
  { value: 'git', label: 'Git repository' },
] as const satisfies readonly { value: ExtensionSourceRequest['kind']; label: string }[]
type InstallPreview = NonNullable<Extract<ExtensionManagementResponse, { ok: true }>['preview']>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function secretReference(installationId: string, key: string): string {
  return `forage-extension/${installationId}/${key}`
}

function sourceLabel(entry: ExtensionCatalogEntry): string {
  if (entry.source.kind === 'local') return `Local · ${entry.source.requestedPath}`
  if (entry.source.kind === 'drop-in') return `Drop-in · ${entry.source.directoryName}`
  if (entry.source.kind === 'npm') return `npm · ${entry.source.spec}`
  return `Git · ${entry.source.url}`
}

function declaredExecutors(entry: ExtensionCatalogEntry) {
  return entry.manifest?.contributes.executors ?? []
}

function SettingsForm({ entry }: { entry: ExtensionCatalogEntry }) {
  const configuration = useExtensionStore((state) => extensionConfigurationFor(state, entry.source.installationId))
  const configure = useExtensionStore((state) => state.configure)
  const busy = useExtensionStore((state) => state.busyInstallationId === entry.source.installationId)
  const declarations = entry.manifest?.contributes.settings ?? []
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => declaredValues(configuration?.settings, declarations))
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({})
  const [clearedSecrets, setClearedSecrets] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [baseline, setBaseline] = useState(() => JSON.stringify(declaredValues(configuration?.settings, declarations)))
  const exit = useDraftExit(JSON.stringify(values) !== baseline || Object.values(secretDrafts).some(Boolean) || clearedSecrets.length > 0, busy, () => undefined)

  useEffect(() => {
    if (JSON.stringify(values) !== baseline || Object.values(secretDrafts).some(Boolean) || clearedSecrets.length) return
    const current = declaredValues(configuration?.settings, declarations)
    setValues(current)
    setBaseline(JSON.stringify(current))
  }, [configuration, declarations])
  if (!declarations.length) return null

  const update = (key: string, value: string | number | boolean) => setValues((current) => ({ ...current, [key]: value }))
  const save = async () => {
    setError(null)
    const secretKeys = new Set(declarations.filter((setting) => setting.type === 'secret').map((setting) => setting.key))
    const references = Object.fromEntries(
      Object.entries(configuration?.secretReferences ?? {}).filter(([key]) => secretKeys.has(key)),
    )
    try {
      for (const declaration of declarations) {
        if (declaration.type !== 'secret') continue
        const reference = secretReference(entry.source.installationId, declaration.key)
        if (clearedSecrets.includes(declaration.key)) {
          await nativeLocalCredentialVault.remove(reference)
          delete references[declaration.key]
        } else if (secretDrafts[declaration.key]) {
          await nativeLocalCredentialVault.store(reference, secretDrafts[declaration.key])
          references[declaration.key] = reference
        }
      }
      await configure(entry.source.installationId, values, references)
      setSecretDrafts({})
      setClearedSecrets([])
      setBaseline(JSON.stringify(values))
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch {
      setError('Could not save configuration. Check required fields and retry.')
    }
  }

  return (
    <section className="extension-configuration" aria-labelledby="extension-configuration-heading">
      <h3 id="extension-configuration-heading">Configuration</h3>
      <p className="settings-hint">These controls are rendered by Forage from the manifest. Extension UI is never loaded here.</p>
      {declarations.map((declaration) => (
        <SettingField
          key={declaration.key}
          declaration={declaration}
          value={values[declaration.key]}
          secretConfigured={Boolean(configuration?.secretReferences?.[declaration.key]) && !clearedSecrets.includes(declaration.key)}
          secretDraft={secretDrafts[declaration.key] ?? ''}
          onChange={(value) => update(declaration.key, value)}
          onSecretChange={(value) => {
            setSecretDrafts((current) => ({ ...current, [declaration.key]: value }))
            setClearedSecrets((current) => current.filter((key) => key !== declaration.key))
          }}
          onClearSecret={() => {
            setSecretDrafts((current) => ({ ...current, [declaration.key]: '' }))
            setClearedSecrets((current) => [...new Set([...current, declaration.key])])
          }}
        />
      ))}
      {error && <p className="settings-error" role="alert">{error}</p>}
      {!configuration && <p className="settings-hint">Trust and enable this source before saving configuration.</p>}
      <Button variant="primary" disabled={busy || !configuration} onClick={() => void save()}>
        {busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save configuration'}
      </Button>
      {exit.dialog}
    </section>
  )
}

function declaredValues(
  values: Record<string, string | number | boolean> | undefined,
  declarations: readonly ExtensionSettingDeclaration[],
): Record<string, string | number | boolean> {
  const allowed = new Set(declarations.filter((setting) => setting.type !== 'secret').map((setting) => setting.key))
  return Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => allowed.has(key)))
}

function SettingField({ declaration, value, secretConfigured, secretDraft, onChange, onSecretChange, onClearSecret }: {
  declaration: ExtensionSettingDeclaration
  value: string | number | boolean | undefined
  secretConfigured: boolean
  secretDraft: string
  onChange: (value: string | number | boolean) => void
  onSecretChange: (value: string) => void
  onClearSecret: () => void
}) {
  const id = `extension-setting-${declaration.key}`
  const label = `${declaration.label}${declaration.required ? ' (required)' : ''}`
  return (
    <div className="extension-setting-field">
      <label htmlFor={id}>{label}</label>
      {declaration.type === 'boolean' ? (
        <Switch id={id} checked={typeof value === 'boolean' ? value : declaration.default ?? false} onCheckedChange={onChange} />
      ) : declaration.type === 'multiline' ? (
        <Textarea id={id} value={typeof value === 'string' ? value : declaration.default ?? ''} onChange={(event) => onChange(event.target.value)} />
      ) : declaration.type === 'number' ? (
        <Input id={id} type="number" min={declaration.minimum} max={declaration.maximum} value={typeof value === 'number' ? value : declaration.default ?? ''} onChange={(event) => onChange(event.target.valueAsNumber)} />
      ) : declaration.type === 'select' ? (
        <Select id={id} value={typeof value === 'string' ? value : declaration.default ?? ''} onChange={(event) => onChange(event.target.value)}>
          {!declaration.default && <option value="">Choose…</option>}
          {declaration.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      ) : declaration.type === 'secret' ? (
        <div className="extension-secret-field">
          <Input id={id} type="password" value={secretDraft} autoComplete="off" placeholder={secretConfigured ? 'Stored locally — enter to replace' : 'Enter secret'} onChange={(event) => onSecretChange(event.target.value)} />
          {secretConfigured && <Button onClick={onClearSecret}>Clear stored secret</Button>}
        </div>
      ) : (
        <Input id={id} value={typeof value === 'string' ? value : declaration.default ?? ''} onChange={(event) => onChange(event.target.value)} />
      )}
      {declaration.description && <p className="settings-hint">{declaration.description}</p>}
    </div>
  )
}

function ExtensionDetail({ entry, onBack, onConfigureTools }: {
  entry: ExtensionCatalogEntry; onBack: () => void; onConfigureTools: () => void
}) {
  const enable = useExtensionStore((state) => state.enable)
  const disable = useExtensionStore((state) => state.disable)
  const reload = useExtensionStore((state) => state.reload)
  const checkUpdates = useExtensionStore((state) => state.checkUpdates)
  const update = useExtensionStore((state) => state.update)
  const remove = useExtensionStore((state) => state.remove)
  const catalog = useExtensionStore((state) => state.catalog)
  const updateAvailability = useExtensionStore((state) => state.updateAvailability[entry.source.installationId])
  const busy = useExtensionStore((state) => state.busyInstallationId === entry.source.installationId)
  const enabledToolIds = useSettingsStore((state) => state.enabledToolIds)
  const loaded = useSettingsStore((state) => state.isLoaded)
  const agents = useSettingsStore((state) => state.agents)
  const saveSkill = useSettingsStore((state) => state.saveSkill)
  const navigation = useSettingsNavigation()
  const { environment, tools } = useEditorTools(extensionToolOptions(catalog))
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null)
  const persistSkill = usePublishedDraft(saveSkill, skillDraft)
  const [error, setError] = useState<string | null>(null)
  const declaration = entry.manifest
  const executors = extensionExecutorOptions(catalog).map((executor) => environment === 'local' ? executor : { ...executor, available: false, unavailableReason: 'Device-local executors require confirmed local execution.' })
  const act = async (action: () => Promise<void>) => {
    setError(null)
    try { await action() } catch { setError('The extension change could not be completed. Review setup and retry; no success is claimed.') }
  }
  const diagnostics = entry.diagnostics.map((diagnostic) => `[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`).join('\n').slice(0, DIAGNOSTIC_COPY_LIMIT)
  const closeSkill = () => { setSkillDraft(null); navigation?.restore({ section: 'extensions', page: 'extension', entityId: entry.source.installationId }, onBack) }
  if (skillDraft) return <section className="settings-section settings-editor"><h2>Create skill</h2><SkillForm key={skillDraft.id} initial={skillDraft} agents={agents} tools={tools} executors={executors} onSave={persistSkill} onCancel={closeSkill} /></section>
  return <section className="settings-section extension-detail" aria-labelledby="extension-detail-heading">
    <SettingsBackLink label="Extensions" onBack={navigation ? navigation.back : onBack} />
    <div className="extension-detail-heading"><span className="settings-server-icon" aria-hidden="true"><Puzzle size={22} /></span><div className="settings-heading-copy"><h2 id="extension-detail-heading">{declaration?.name ?? entry.source.installationId}</h2><p className="settings-hint">{declaration?.description ?? 'This source has no readable Forage manifest.'}</p></div><ExtensionStatusPill entry={entry} /></div>
    <p className="settings-hint settings-footnote">Version {declaration?.version ?? 'unavailable'} · {sourceLabel(entry)}</p>
    {declaration?.contributes.settings.length ? <SettingsForm key={entry.source.installationId} entry={entry} /> : <section><h3>Configuration</h3><p className="settings-hint">{declaration ? 'No setup required.' : 'Configuration is unavailable until the manifest can be read.'}</p></section>}
    <section className="settings-divider"><h3>Tools</h3>{entry.tools.length ? entry.tools.map((tool) => <SwitchFieldInput key={tool.id} className="settings-tool-choice" label={tool.name} hint={entry.status === 'ready' && tool.available && environment === 'local' ? tool.description : 'Unavailable: review trust, configuration, compatibility, and execution environment.'} checked={enabledToolIds.includes(tool.id)} disabled={busy || !loaded || entry.status !== 'ready' || !tool.available || environment !== 'local'} onCheckedChange={(checked) => void act(async () => {
      await useSettingsStore.getState().setToolEnabled(tool.id, checked)
      try { await publishLocalAgentConfiguration() } catch { setError('Tool policy was saved on this device, but not published to the server. Retry publication in Connection.') }
    })} />) : <p className="settings-hint">No agent tools. Use a declared action in a skill, if available.</p>}
    </section>
    {entry.tools.length > 0 && <section className="extension-agent-access"><h3>Agent access</h3><div className="settings-block">{agents.map((agent) => <div key={agent.id} className="settings-extension-access-row"><div><p>{agent.name}</p><p className="settings-hint settings-footnote">{entry.tools.filter((tool) => agent.toolIds.includes(tool.id)).length} of {entry.tools.length} tools selected</p></div><Button size="sm" onClick={() => navigation ? navigation.open('agents', 'agent', undefined, agent.id) : onConfigureTools()}>Edit {agent.name} tools</Button></div>)}</div>{!agents.length && <p>No agents configured.</p>}<Button variant="ghost" className="settings-text-link" onClick={onConfigureTools}>Manage agents</Button></section>}
    <section className="settings-divider"><h3>Use in a skill</h3>{declaredExecutors(entry).length ? declaredExecutors(entry).map((executor) => {
      const option = executors.find((candidate) => candidate.extensionId === declaration?.id && candidate.executorId === executor.id)
      return <div key={executor.id} className="settings-extension-executor"><div><strong>{executor.name}</strong><p className="settings-hint settings-footnote">{executor.description}</p>{!option?.available && <p className="settings-hint settings-footnote">{option?.unavailableReason ?? 'Requires configuration before running.'}</p>}</div><Button aria-label={`Create skill using ${executor.name}`} disabled={!declaration || !option?.available || busy} onClick={() => {
        const create = () => {
        setSkillDraft({ id: `draft_${crypto.randomUUID()}`, label: '', description: '', execution: 'extension', executor: { extensionId: declaration!.id, executorId: executor.id }, configuration: configurationWithDefaults(executor.configuration) })
        navigation?.open('extensions', 'skill', () => { setSkillDraft(null); onBack() })
        }
        if (navigation) navigation.requestLeave(create); else create()
      }}>Create skill</Button></div>
    }) : <p className="settings-hint">No skill actions declared.</p>}</section>
    <details><summary>Extension details</summary>
      <dl className="m-0 flex flex-col"><DefinitionRow term="Identity">{declaration?.id ?? 'Unavailable'}</DefinitionRow><DefinitionRow term="Source" mono={false}>{sourceLabel(entry)}</DefinitionRow><DefinitionRow term="Revision">{entry.provenance?.sourceRevision ?? 'Unavailable'}</DefinitionRow><DefinitionRow term="Compatibility" mono={false}>{declaration ? 'Current Forage extension contract; readiness remains gated by status.' : 'Invalid or missing manifest'}</DefinitionRow><DefinitionRow term="Lifecycle hooks" mono={false}>{declaration?.contributes.hooks.join(', ') || 'No hooks declared.'}</DefinitionRow></dl>
      <Callout tone="caution" title="Trusted local code"><p>Enabling runs Node.js code with your user permissions, including access to files, network, and supplied values. Tool switches are not a sandbox and do not disable lifecycle hooks.</p></Callout>
      {entry.diagnostics.length > 0 && <section className="extension-diagnostics"><h3>Diagnostics</h3><pre>{diagnostics}</pre><Button onClick={() => void (async () => { try { await navigator.clipboard.writeText(diagnostics) } catch { setError('Clipboard unavailable. Select the diagnostic text instead.') } })()}>Copy diagnostics</Button></section>}
    </details>
    {entry.status === 'needs_review' && <p className="settings-hint">Review trusted local code in Extension details before enabling.</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="settings-actions settings-divider extension-actions">
        {entry.status === 'needs_review' && declaration && <ConfirmButton disabled={busy} label="Review & enable" confirmLabel="Trust and enable" onConfirm={() => void act(() => enable(entry.source.installationId))} />}
        {['ready', 'needs_configuration'].includes(entry.status) && <ConfirmButton disabled={busy} label="Disable" confirmLabel="Confirm disable" onConfirm={() => void act(() => disable(entry.source.installationId))} />}
        {entry.status === 'disabled' && declaration && <ConfirmButton disabled={busy} label="Enable" confirmLabel="Confirm enable" onConfirm={() => void act(() => enable(entry.source.installationId))} />}
        {declaration && <ConfirmButton disabled={busy} label="Reload" confirmLabel="Confirm reload" onConfirm={() => void act(() => reload(entry.source.installationId))} />}
        {(entry.source.kind === 'npm' || entry.source.kind === 'git') && <Button disabled={busy} onClick={() => void act(() => checkUpdates(entry.source.installationId))}>Check for updates</Button>}
        {updateAvailability?.available && <ConfirmButton disabled={busy} label={`Update${updateAvailability.revision ? ` to ${updateAvailability.revision}` : ''}`} confirmLabel="Confirm update" onConfirm={() => void act(() => update(entry.source.installationId))} />}
        <Button disabled={busy} onClick={() => void act(() => revealItemInDir(entry.source.canonicalPath))}>Open source folder</Button>
        {entry.source.kind !== 'drop-in' && <ConfirmButton disabled={busy} label="Remove" confirmLabel="Confirm remove" variant="danger" onConfirm={() => void act(() => remove(entry.source.installationId).then(onBack))} />}
      </div>

    {busy && <p className="settings-hint" aria-live="polite">Applying extension change…</p>}
  </section>
}

function InstallPreviewCard({ preview, busy, onBack, onInstall }: {
  preview: InstallPreview
  busy: boolean
  onBack: () => void
  onInstall: () => void
}) {
  const declaration = preview.entry.manifest!
  const revision = preview.entry.source.kind === 'npm'
    ? preview.entry.source.resolvedVersion
    : preview.entry.source.kind === 'git'
      ? preview.entry.source.resolvedCommit
      : preview.entry.provenance?.sourceRevision ?? 'local directory'
  const installable = Boolean(preview.entry.manifest && preview.entry.status !== 'error')
  return <div className="extension-install-preview">
    <h3>{declaration.name} <small>{declaration.version}</small></h3>
    <p>{declaration.description}</p>
    <dl className="m-0 flex flex-col">
      <DefinitionRow term="Identity">{declaration.id}</DefinitionRow>
      <DefinitionRow term="Resolved revision">{revision}</DefinitionRow>
      <DefinitionRow term="Contributions" mono={false}>{declaration.contributes.tools.length} tool(s), {declaration.contributes.executors?.length ?? 0} executor(s), {declaration.contributes.hooks.length} hook(s), {declaration.contributes.settings.length} setting(s)</DefinitionRow>
      <DefinitionRow term="Compatibility" mono={false}>{installable ? 'Compatible with this Forage version' : 'Cannot be installed — review diagnostics'}</DefinitionRow>
    </dl>
    {preview.entry.diagnostics.length > 0 && <div className="extension-diagnostics"><pre>{preview.entry.diagnostics.map((item) => `[${item.severity}] ${item.message}`).join('\n')}</pre></div>}
    <Callout tone="caution" title="Review trusted code before enabling"><p>Installing only records this source. It does not trust or enable its code, fill settings, globally authorize tools, or add tools to an agent. Enabling later runs the extension with your user permissions.</p></Callout>
    <div className="settings-actions"><Button variant="primary" disabled={busy || !installable} onClick={onInstall}>{installable ? preview.requestedSource.kind === 'local' ? 'Register source' : 'Install staged revision' : 'Cannot install'}</Button><Button disabled={busy} onClick={onBack}>Back</Button></div>
  </div>
}

export function ExtensionsSettings({ onConfigureTools }: { onConfigureTools: () => void }) {
  const catalog = useExtensionStore((state) => state.catalog)
  const extensionsDirectory = useExtensionStore((state) => state.extensionsDirectory)
  const isLoaded = useExtensionStore((state) => state.isLoaded)
  const isLoading = useExtensionStore((state) => state.isLoading)
  const error = useExtensionStore((state) => state.error)
  const refresh = useExtensionStore((state) => state.refresh)
  const previewInstall = useExtensionStore((state) => state.previewInstall)
  const confirmInstall = useExtensionStore((state) => state.install)
  const installBusy = useExtensionStore((state) => state.busyInstallationId === 'install-preview' || state.busyInstallationId === null && state.isLoading)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const navigation = useSettingsNavigation()
  const selectExtension = (id: string | null) => {
    const select = () => {
    setSelectedId(id)
    if (id) navigation?.open('extensions', 'extension', () => setSelectedId(null), id)
    else if (navigation?.route.page === 'extension') navigation.back()
    }
    if (navigation) navigation.requestLeave(select); else select()
  }
  const [showInstall, setShowInstall] = useState(false)
  const [sourceKind, setSourceKind] = useState<ExtensionSourceRequest['kind']>('local')
  const [sourceValue, setSourceValue] = useState('')
  const [gitRef, setGitRef] = useState('')
  const [preview, setPreview] = useState<InstallPreview | null>(null)
  const [installWorking, setInstallWorking] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => { if (!isLoaded && !isLoading) void refresh().catch(() => undefined) }, [isLoaded, isLoading, refresh])
  const selected = catalog?.entries.find((entry) => entry.source.installationId === selectedId)
  useEffect(() => {
    if (isLoaded && selectedId && !selected) {
      setSelectedId(null)
      navigation?.clearGuard()
      navigation?.back()
      setActionError('This extension is no longer available. Returned to Extensions.')
    }
  }, [isLoaded, selectedId, selected, navigation])
  const groups = useMemo(() => [
    ['Needs attention', catalog?.entries.filter((entry) => ['needs_review', 'needs_configuration', 'error'].includes(entry.status)) ?? []],
    ['Enabled', catalog?.entries.filter((entry) => entry.status === 'ready') ?? []],
    ['Disabled', catalog?.entries.filter((entry) => entry.status === 'disabled') ?? []],
  ] as const, [catalog])

  if (selected) return <ExtensionDetail entry={selected} onBack={() => selectExtension(null)} onConfigureTools={onConfigureTools} />

  const requestedSource = (): ExtensionSourceRequest => sourceKind === 'npm'
    ? { kind: 'npm', spec: sourceValue.trim() }
    : { kind: 'git', url: sourceValue.trim(), ...(gitRef.trim() ? { ref: gitRef.trim() } : {}) }
  const inspect = async (source: ExtensionSourceRequest) => {
    setActionError(null)
    setInstallWorking(true)
    try {
      setPreview(await previewInstall(source))
    } catch (installError) { setActionError(errorMessage(installError)) } finally { setInstallWorking(false) }
  }
  const chooseLocalFolder = async () => {
    setActionError(null)
    let selection: string | string[] | null
    try {
      selection = await openDialog({ directory: true, multiple: false, title: 'Choose an extension folder' })
    } catch (dialogError) {
      setActionError(errorMessage(dialogError))
      return
    }
    if (typeof selection !== 'string') return
    setSourceValue(selection)
    await inspect({ kind: 'local', path: selection })
  }
  const openExtensionsFolder = async () => {
    if (!extensionsDirectory) return
    setActionError(null)
    try { await openPath(extensionsDirectory) } catch (openError) { setActionError(errorMessage(openError)) }
  }
  const install = async () => {
    if (!preview) return
    setActionError(null)
    setInstallWorking(true)
    try {
      await confirmInstall(preview.requestedSource, preview.previewId)
      setSourceValue('')
      setGitRef('')
      setPreview(null)
      setShowInstall(false)
    } catch (installError) { setActionError(errorMessage(installError)) } finally { setInstallWorking(false) }
  }

  return (
    <section className="settings-section extensions-settings" aria-labelledby="extensions-heading">
      <div className="extensions-toolbar"><div className="settings-heading-copy"><h2 id="extensions-heading">Extensions</h2><p className="settings-hint">Inventory reads Forage manifests only. It does not execute code or contact package registries.</p></div><div className="settings-actions"><Button size="sm" onClick={() => setShowInstall((shown) => !shown)}>Install</Button><Button size="sm" disabled={!extensionsDirectory} onClick={() => void openExtensionsFolder()}>Open folder</Button><Button size="sm" disabled={isLoading} onClick={() => void refresh().catch(() => undefined)}>{isLoading ? 'Refreshing…' : 'Refresh'}</Button></div></div>
      <div className="settings-block settings-notices">
      <Callout tone="caution" title="Extensions are trusted local code"><p>Review the manifest and source before enabling. Installation, enablement, configuration, and model tool authorization are separate decisions.</p></Callout>
      <Callout tone="info" title="Local execution only."><p>When server execution is authoritative, local extension tools and skill executors are unavailable and Forage will not fall back to this device.</p></Callout>
      </div>
      {showInstall && <div className="custom-tool-form extension-install-flow">
        <strong>Install or register an extension</strong>
        {!preview ? <>
          <SegmentedControl
            ariaLabel="Source type"
            value={sourceKind}
            options={SOURCE_KIND_OPTIONS}
            onValueChange={(kind) => { setSourceKind(kind); setSourceValue(''); setGitRef(''); setActionError(null) }}
          />
          {sourceKind === 'local' ? <>
            {sourceValue && <p className="settings-hint">Last chosen: <code>{sourceValue}</code></p>}
            <p className="settings-hint">Choosing a folder only inspects its Forage manifest. Nothing runs until you enable it.</p>
            <div className="settings-actions"><Button variant="primary" disabled={installWorking || installBusy} onClick={() => void chooseLocalFolder()}>{installWorking || installBusy ? 'Inspecting…' : 'Choose folder…'}</Button><Button onClick={() => setShowInstall(false)}>Cancel</Button></div>
          </> : <>
            <Field label={sourceKind === 'npm' ? 'npm specification' : 'Git HTTPS or SSH URL'} htmlFor="extension-source-value">
              <Input id="extension-source-value" mono value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} placeholder={sourceKind === 'npm' ? 'npm:example-forage-tools@1.2.3' : 'https://github.com/example/forage-tools.git'} />
            </Field>
            {sourceKind === 'git' && <><Field label="Ref (optional; pins updates)" htmlFor="extension-git-ref"><Input id="extension-git-ref" mono value={gitRef} onChange={(event) => setGitRef(event.target.value)} placeholder="v1.2.3 or commit" /></Field></>}
            <p className="settings-hint">Preview is explicit: npm/Git sources may contact their registry or remote and are staged with lifecycle scripts disabled.</p>
            <div className="settings-actions"><Button variant="primary" disabled={!sourceValue.trim() || installWorking || installBusy} onClick={() => void inspect(requestedSource())}>{installWorking || installBusy ? 'Inspecting…' : 'Preview source'}</Button><Button onClick={() => setShowInstall(false)}>Cancel</Button></div>
          </>}
        </> : <InstallPreviewCard preview={preview} busy={installWorking} onBack={() => setPreview(null)} onInstall={() => void install()} />}
      </div>}
      {(actionError || error) && <p className="settings-error" role="alert">{actionError || error}</p>}
      {!isLoading && catalog?.entries.length === 0 && <div className="extension-empty"><strong>No extensions found</strong><p>Put a manifest-bearing directory in the Extensions folder or register a local development directory.</p></div>}
{groups.map(([label, entries]) => entries.length > 0 && <section key={label} className="extension-group" aria-label={label}><h3>{label} <CountBadge tone={label === 'Needs attention' ? 'attention' : 'default'}>{entries.length}</CountBadge></h3><div className="settings-row-list">{entries.map((entry) => { const declaration = entry.manifest; return <ListRow key={entry.source.installationId} leading={<Puzzle />} title={declaration?.name ?? entry.source.installationId} description={declaration ? `${declaration.version} · ${sourceLabel(entry)} · ${declaration.description}` : sourceLabel(entry)} meta={`${entry.tools.length} tool(s) · ${entry.executors?.length ?? 0} executor(s) · ${declaration?.contributes.hooks.length ?? 0} hook(s)`} status={<ExtensionStatusPill entry={entry} />} onClick={() => selectExtension(entry.source.installationId)} /> })}</div></section>)}
    </section>
  )
}

const EXTENSION_STATUS_TONE: Record<ExtensionCatalogEntry['status'], StatusTone> = {
  ready: 'success',
  needs_review: 'danger',
  needs_configuration: 'danger',
  error: 'danger',
  disabled: 'muted',
}

function ExtensionStatusPill({ entry }: { entry: ExtensionCatalogEntry }) {
  return <StatusPill tone={EXTENSION_STATUS_TONE[entry.status]} icon={false}>{statusLabel(entry)}</StatusPill>
}
