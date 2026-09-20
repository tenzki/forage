import { useEffect, useMemo, useState } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import type {
  ExtensionCatalogEntry,
  ExtensionManagementResponse,
  ExtensionSettingDeclaration,
  ExtensionSourceRequest,
} from '@forage/agent-runtime'
import { nativeLocalCredentialVault } from '../../agent/localCredentials'
import {
  extensionConfigurationFor,
  statusLabel,
  useExtensionStore,
} from '../../store/extensionStore'
import { ConfirmButton } from './ConfirmButton'
import { useSettingsStore } from '../../store/settingsStore'

const DIAGNOSTIC_COPY_LIMIT = 16_000
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

  useEffect(() => setValues(declaredValues(configuration?.settings, declarations)), [configuration, declarations])
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
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch (saveError) {
      setError(errorMessage(saveError))
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
      <button type="button" className="settings-save" disabled={busy || !configuration} onClick={() => void save()}>
        {busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save configuration'}
      </button>
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
        <input id={id} type="checkbox" checked={typeof value === 'boolean' ? value : declaration.default ?? false} onChange={(event) => onChange(event.target.checked)} />
      ) : declaration.type === 'multiline' ? (
        <textarea id={id} value={typeof value === 'string' ? value : declaration.default ?? ''} onChange={(event) => onChange(event.target.value)} />
      ) : declaration.type === 'number' ? (
        <input id={id} type="number" min={declaration.minimum} max={declaration.maximum} value={typeof value === 'number' ? value : declaration.default ?? ''} onChange={(event) => onChange(event.target.valueAsNumber)} />
      ) : declaration.type === 'select' ? (
        <select id={id} value={typeof value === 'string' ? value : declaration.default ?? ''} onChange={(event) => onChange(event.target.value)}>
          {!declaration.default && <option value="">Choose…</option>}
          {declaration.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : declaration.type === 'secret' ? (
        <div className="extension-secret-field">
          <input id={id} type="password" value={secretDraft} autoComplete="off" placeholder={secretConfigured ? 'Stored locally — enter to replace' : 'Enter secret'} onChange={(event) => onSecretChange(event.target.value)} />
          {secretConfigured && <button type="button" className="settings-secondary" onClick={onClearSecret}>Clear stored secret</button>}
        </div>
      ) : (
        <input id={id} value={typeof value === 'string' ? value : declaration.default ?? ''} onChange={(event) => onChange(event.target.value)} />
      )}
      {declaration.description && <p className="settings-hint">{declaration.description}</p>}
    </div>
  )
}

function ExtensionDetail({ entry, onBack, onConfigureTools }: {
  entry: ExtensionCatalogEntry
  onBack: () => void
  onConfigureTools: () => void
}) {
  const enable = useExtensionStore((state) => state.enable)
  const disable = useExtensionStore((state) => state.disable)
  const reload = useExtensionStore((state) => state.reload)
  const checkUpdates = useExtensionStore((state) => state.checkUpdates)
  const update = useExtensionStore((state) => state.update)
  const remove = useExtensionStore((state) => state.remove)
  const updateAvailability = useExtensionStore((state) => state.updateAvailability[entry.source.installationId])
  const busy = useExtensionStore((state) => state.busyInstallationId === entry.source.installationId)
  const enabledToolIds = useSettingsStore((state) => state.enabledToolIds)
  const [error, setError] = useState<string | null>(null)
  const declaration = entry.manifest
  if (!declaration) return <p className="settings-error">This source has no readable Forage manifest.</p>
  const act = async (action: () => Promise<void>) => {
    setError(null)
    try { await action() } catch (actionError) { setError(errorMessage(actionError)) }
  }
  const diagnostics = entry.diagnostics.map((diagnostic) => `[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`).join('\n').slice(0, DIAGNOSTIC_COPY_LIMIT)

  return (
    <section className="settings-section extension-detail" aria-labelledby="extension-detail-heading">
      <button type="button" className="settings-secondary extension-back" onClick={onBack}>← All extensions</button>
      <div className="extension-detail-heading">
        <div><h2 id="extension-detail-heading">{declaration.name}</h2><p>{declaration.description}</p></div>
        <span className={`extension-status is-${entry.status}`}>{statusLabel(entry)}</span>
      </div>
      <dl className="extension-metadata">
        <div><dt>Identity</dt><dd><code>{declaration.id}</code></dd></div>
        <div><dt>Version</dt><dd>{declaration.version}</dd></div>
        <div><dt>Source</dt><dd>{sourceLabel(entry)}</dd></div>
        <div><dt>Revision</dt><dd><code>{entry.provenance?.sourceRevision ?? 'Unavailable'}</code></dd></div>
        <div><dt>Contract</dt><dd>{entry.manifest ? 'Current Forage extension contract' : 'Invalid extension manifest'}</dd></div>
        <div><dt>Authorization</dt><dd>{entry.tools.filter((tool) => enabledToolIds.includes(tool.id)).length} of {entry.tools.length} tools globally enabled</dd></div>
      </dl>

      <div className="extension-warning" role="note">
        <strong>Trusted local code</strong>
        <p>Enabling this source runs Node.js code with your user permissions. It can access local files, the network, process resources, and values supplied to its run process. The process boundary and tool switches are not a sandbox; disabling a tool does not disable lifecycle hooks.</p>
      </div>

      <section><h3>Declared tools</h3>{declaration.contributes.tools.length ? <ul>{declaration.contributes.tools.map((tool) => <li key={tool.id}><strong>{tool.name}</strong> <code>{tool.id}</code><small>{tool.description}</small></li>)}</ul> : <p className="settings-hint">No tools declared.</p>}</section>
      <section><h3>Skill executors</h3>{declaredExecutors(entry).length ? <ul>{declaredExecutors(entry).map((executor) => {
        const readiness = entry.executors?.find((candidate) => candidate.id === executor.id)
        return <li key={executor.id}><strong>{executor.name}</strong> <code>{declaration.id}/{executor.id}</code><small>{executor.description} {executor.configuration.fields.length} configuration field(s). {readiness?.available ? 'Ready for explicit skill selection.' : 'Unavailable.'}</small></li>
      })}</ul> : <p className="settings-hint">No skill executors declared.</p>}</section>
      <section><h3>Lifecycle hooks</h3><p className="settings-hint">{declaration.contributes.hooks.join(', ') || 'No hooks declared.'}</p></section>
      <section><h3>Declared settings</h3><p className="settings-hint">{declaration.contributes.settings.map((setting) => `${setting.label} (${setting.type}${setting.required ? ', required' : ''})`).join(' · ') || 'No settings declared.'}</p></section>

      {entry.manifest && <SettingsForm entry={entry} />}

      {entry.diagnostics.length > 0 && (
        <section className="extension-diagnostics"><h3>Diagnostics</h3><pre>{diagnostics}</pre><button type="button" className="settings-secondary" onClick={() => void navigator.clipboard.writeText(diagnostics)}>Copy diagnostics</button></section>
      )}
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="settings-actions extension-actions">
        {entry.status === 'needs_review' && entry.manifest && <ConfirmButton disabled={busy} label="Review & enable" confirmLabel="Trust and enable" onConfirm={() => void act(() => enable(entry.source.installationId))} />}
        {['ready', 'needs_configuration'].includes(entry.status) && <ConfirmButton disabled={busy} label="Disable" confirmLabel="Confirm disable" onConfirm={() => void act(() => disable(entry.source.installationId))} />}
        {entry.status === 'disabled' && entry.manifest && <ConfirmButton disabled={busy} label="Enable" confirmLabel="Confirm enable" onConfirm={() => void act(() => enable(entry.source.installationId))} />}
        {entry.manifest && <ConfirmButton disabled={busy} label="Reload" confirmLabel="Confirm reload" onConfirm={() => void act(() => reload(entry.source.installationId))} />}
        {(entry.source.kind === 'npm' || entry.source.kind === 'git') && <button disabled={busy} type="button" className="settings-secondary" onClick={() => void act(() => checkUpdates(entry.source.installationId))}>Check for updates</button>}
        {updateAvailability?.available && <ConfirmButton disabled={busy} label={`Update${updateAvailability.revision ? ` to ${updateAvailability.revision}` : ''}`} confirmLabel="Confirm update" onConfirm={() => void act(() => update(entry.source.installationId))} />}
        <button disabled={busy} type="button" className="settings-secondary" onClick={() => void act(() => revealItemInDir(entry.source.canonicalPath))}>Open source folder</button>
        {entry.tools.length > 0 && <button disabled={busy} type="button" className="settings-secondary" onClick={onConfigureTools}>Configure tools</button>}
        {entry.source.kind !== 'drop-in' && <ConfirmButton disabled={busy} label="Remove" confirmLabel="Confirm remove" className="danger-action" onConfirm={() => void act(() => remove(entry.source.installationId).then(onBack))} />}
      </div>
      {busy && <p className="settings-hint" aria-live="polite">Applying extension change…</p>}
    </section>
  )
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
    <dl className="extension-metadata">
      <div><dt>Identity</dt><dd><code>{declaration.id}</code></dd></div>
      <div><dt>Resolved revision</dt><dd><code>{revision}</code></dd></div>
      <div><dt>Contributions</dt><dd>{declaration.contributes.tools.length} tool(s), {declaration.contributes.executors?.length ?? 0} executor(s), {declaration.contributes.hooks.length} hook(s), {declaration.contributes.settings.length} setting(s)</dd></div>
      <div><dt>Compatibility</dt><dd>{installable ? 'Compatible with this Forage version' : 'Cannot be installed — review diagnostics'}</dd></div>
    </dl>
    {preview.entry.diagnostics.length > 0 && <div className="extension-diagnostics"><pre>{preview.entry.diagnostics.map((item) => `[${item.severity}] ${item.message}`).join('\n')}</pre></div>}
    <div className="extension-warning" role="note"><strong>Review trusted code before enabling</strong><p>Installing only records this source. It does not trust or enable its code, fill settings, globally authorize tools, or add tools to an agent. Enabling later runs the extension with your user permissions.</p></div>
    <div className="settings-actions"><button type="button" className="settings-save" disabled={busy || !installable} onClick={onInstall}>{installable ? preview.requestedSource.kind === 'local' ? 'Register source' : 'Install staged revision' : 'Cannot install'}</button><button type="button" className="settings-secondary" disabled={busy} onClick={onBack}>Back</button></div>
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
  const [showInstall, setShowInstall] = useState(false)
  const [sourceKind, setSourceKind] = useState<ExtensionSourceRequest['kind']>('local')
  const [sourceValue, setSourceValue] = useState('')
  const [gitRef, setGitRef] = useState('')
  const [preview, setPreview] = useState<InstallPreview | null>(null)
  const [installWorking, setInstallWorking] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => { if (!isLoaded && !isLoading) void refresh().catch(() => undefined) }, [isLoaded, isLoading, refresh])
  const selected = catalog?.entries.find((entry) => entry.source.installationId === selectedId)
  const groups = useMemo(() => [
    ['Needs attention', catalog?.entries.filter((entry) => ['needs_review', 'needs_configuration', 'error'].includes(entry.status)) ?? []],
    ['Enabled', catalog?.entries.filter((entry) => entry.status === 'ready') ?? []],
    ['Disabled', catalog?.entries.filter((entry) => entry.status === 'disabled') ?? []],
  ] as const, [catalog])

  if (selected) return <ExtensionDetail entry={selected} onBack={() => setSelectedId(null)} onConfigureTools={onConfigureTools} />

  const requestedSource = (): ExtensionSourceRequest => sourceKind === 'local'
    ? { kind: 'local', path: sourceValue.trim() }
    : sourceKind === 'npm'
      ? { kind: 'npm', spec: sourceValue.trim() }
      : { kind: 'git', url: sourceValue.trim(), ...(gitRef.trim() ? { ref: gitRef.trim() } : {}) }
  const inspect = async () => {
    setActionError(null)
    setInstallWorking(true)
    try {
      setPreview(await previewInstall(requestedSource()))
    } catch (installError) { setActionError(errorMessage(installError)) } finally { setInstallWorking(false) }
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
      <div className="extensions-toolbar"><div><h2 id="extensions-heading">Extensions</h2><p className="settings-hint">Inventory reads Forage manifests only. It does not execute code or contact package registries.</p></div><div className="settings-actions"><button type="button" className="settings-secondary" onClick={() => setShowInstall((shown) => !shown)}>Install</button><button type="button" className="settings-secondary" disabled={!extensionsDirectory} onClick={() => extensionsDirectory && void revealItemInDir(extensionsDirectory)}>Open folder</button><button type="button" className="settings-secondary" disabled={isLoading} onClick={() => void refresh().catch(() => undefined)}>{isLoading ? 'Refreshing…' : 'Refresh'}</button></div></div>
      <div className="extension-warning"><strong>Extensions are trusted local code</strong><p>Review the manifest and source before enabling. Installation, enablement, configuration, and model tool authorization are separate decisions.</p></div>
      <div className="extension-local-only"><strong>Local execution only.</strong> When server execution is authoritative, local extension tools and skill executors are unavailable and Forage will not fall back to this device.</div>
      {showInstall && <div className="custom-tool-form extension-install-flow">
        <strong>Install or register an extension</strong>
        {!preview ? <>
          <label htmlFor="extension-source-kind">Source type</label>
          <select id="extension-source-kind" value={sourceKind} onChange={(event) => { setSourceKind(event.target.value as ExtensionSourceRequest['kind']); setActionError(null) }}>
            <option value="local">Local directory</option><option value="npm">npm package</option><option value="git">Git repository</option>
          </select>
          <label htmlFor="extension-source-value">{sourceKind === 'local' ? 'Directory path' : sourceKind === 'npm' ? 'npm specification' : 'Git HTTPS or SSH URL'}</label>
          <input id="extension-source-value" className="settings-monospace" value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} placeholder={sourceKind === 'local' ? '/path/to/extension' : sourceKind === 'npm' ? 'npm:example-forage-tools@1.2.3' : 'https://github.com/example/forage-tools.git'} />
          {sourceKind === 'git' && <><label htmlFor="extension-git-ref">Ref (optional; pins updates)</label><input id="extension-git-ref" className="settings-monospace" value={gitRef} onChange={(event) => setGitRef(event.target.value)} placeholder="v1.2.3 or commit" /></>}
          <p className="settings-hint">Preview is explicit: npm/Git sources may contact their registry or remote and are staged with lifecycle scripts disabled. Local directories are only inspected.</p>
          <div className="settings-actions"><button type="button" className="settings-save" disabled={!sourceValue.trim() || installWorking || installBusy} onClick={() => void inspect()}>{installWorking || installBusy ? 'Inspecting…' : 'Preview source'}</button><button type="button" className="settings-secondary" onClick={() => setShowInstall(false)}>Cancel</button></div>
        </> : <InstallPreviewCard preview={preview} busy={installWorking} onBack={() => setPreview(null)} onInstall={() => void install()} />}
      </div>}
      {(actionError || error) && <p className="settings-error" role="alert">{actionError || error}</p>}
      {!isLoading && catalog?.entries.length === 0 && <div className="extension-empty"><strong>No extensions found</strong><p>Put a manifest-bearing directory in the Extensions folder or register a local development directory.</p></div>}
      {groups.map(([label, entries]) => entries.length > 0 && <section key={label} className="extension-group" aria-label={label}><h3>{label} <span>{entries.length}</span></h3><div className="tool-list">{entries.map((entry) => { const declaration = entry.manifest; return <button key={entry.source.installationId} type="button" className="tool-setting extension-row" onClick={() => setSelectedId(entry.source.installationId)}><span><strong>{declaration?.name ?? entry.source.installationId}</strong><small>{declaration ? `${declaration.version} · ${sourceLabel(entry)}` : sourceLabel(entry)}</small><code>{entry.tools.length} tool(s) · {entry.executors?.length ?? 0} executor(s) · {declaration?.contributes.hooks.length ?? 0} hook(s)</code></span><span className={`extension-status is-${entry.status}`}>{statusLabel(entry)}</span></button> })}</div></section>)}
    </section>
  )
}
