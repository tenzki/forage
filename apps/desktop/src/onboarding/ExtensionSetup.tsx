import { useEffect, useState } from 'react'
import { resolveResource } from '@tauri-apps/api/path'
import type { ExtensionManagementResponse } from '@forage/agent-runtime'
import imageManifest from '../../../../extensions/image-generation/forage.extension.json'
import textManifest from '../../../../extensions/reference/forage.extension.json'
import systemManifest from '../../../../extensions/system-one/forage.extension.json'
import { extensionToolOptions, statusLabel, useExtensionStore } from '../store/extensionStore'
import { useSettingsStore } from '../store/settingsStore'
import { ExtensionDetail, InstallPreviewCard } from '../components/Settings/ExtensionsSettings'
import { AgentForm, SkillForm } from '../components/Settings/AgentEditors'
import type { SkillDraft } from '../agent/definitions'
import { extensionExecutorOptions } from '../store/extensionStore'
import { useEditorTools } from '../components/Settings/useEditorTools'
import { Button } from '../components/ui/Button'
import { useOnboardingStore } from './progress'

type Preview = NonNullable<Extract<ExtensionManagementResponse, { ok: true }>['preview']>
const supplied = [
  { key: 'image-generation', manifest: imageManifest, prerequisites: 'Requires Node.js and a separate OpenAI API key or local Codex login.' },
  { key: 'text-stats', manifest: textManifest, prerequisites: 'Runs locally with Node.js; no AI account required.' },
  { key: 'system-one', manifest: systemManifest, prerequisites: 'Requires a System One account and API credentials.' },
]

export function ExtensionSetup({ selected, setSelected, configuring, onConfigured }: {
  selected: string[]; setSelected: (value: string[]) => void; configuring: boolean; onConfigured: () => void
}) {
  const state = useExtensionStore()
  const settings = useSettingsStore()
  const [index, setIndex] = useState(0)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [installedId, setInstalledId] = useState<string | null>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editorTools = useEditorTools(extensionToolOptions(state.catalog))
  useEffect(() => { setIndex(0); setPreview(null); setInstalledId(null); setAgentId(null); setSkillDraft(null) }, [configuring])
  const choices = [
    ...supplied.map(source => ({ id: source.manifest.id, name: source.manifest.name, description: source.manifest.description, prerequisites: source.prerequisites })),
    ...(state.catalog?.entries ?? []).filter(entry => entry.manifest && !supplied.some(source => source.manifest.id === entry.manifest!.id)).map(entry => ({ id: entry.manifest!.id, name: entry.manifest!.name, description: entry.manifest!.description, prerequisites: 'Review this installed source, its revision, and its prerequisites before enabling.' })),
  ]
  const currentId = selected[index]
  const entry = state.catalog?.entries.find(entry => installedId ? entry.source.installationId === installedId : entry.manifest?.id === currentId)
  const perform = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { await action() } catch { setError('Extension setup could not be completed. Previously saved configuration is kept. Retry or skip this source.') }
    finally { setBusy(false) }
  }
  const inspect = () => perform(async () => {
    const source = supplied.find(source => source.manifest.id === currentId)
    if (!source) throw new Error('Source unavailable')
    const path = await resolveResource(`resources/pi/sidecar/dist/extensions/${source.key}`)
    setPreview(await state.previewInstall({ kind: 'local', path }))
  })
  const next = () => perform(async () => {
    if (entry?.provenance?.sourceRevision) {
      const progress = useOnboardingStore.getState().progress!
      await useOnboardingStore.getState().update({ extensions: [...progress.extensions.filter(reference => reference.installationId !== entry.source.installationId), { installationId: entry.source.installationId, revision: entry.provenance.sourceRevision }] })
    }
    setPreview(null); setInstalledId(null); setAgentId(null)
    if (index + 1 < selected.length) setIndex(index + 1)
    else onConfigured()
  })
  const agent = settings.agents.find(agent => agent.id === agentId)
  if (!configuring) return <div className="onboarding-choices" aria-label="Extension choices">
    <p className="settings-hint">Choose what’s useful to you. You can add or configure extensions later in Settings.</p>
    {choices.map(choice => <label className="onboarding-choice" key={choice.id}>
      <input type="checkbox" checked={selected.includes(choice.id)} onChange={event => setSelected(event.target.checked ? [...selected, choice.id] : selected.filter(id => id !== choice.id))} />
      <span><strong>{choice.name}</strong><span>{choice.description}</span><small>{choice.prerequisites}</small></span>
    </label>)}
    {state.error && <p role="alert">Could not read installed extensions. You can retry in Settings or skip for now.</p>}
  </div>
  return <div className="onboarding-extension-setup">
    <p className="settings-hint">{index + 1} of {selected.length} selected extensions</p>
    {skillDraft ? <SkillForm initial={skillDraft} agents={settings.agents} tools={editorTools.tools} executors={extensionExecutorOptions(state.catalog)} onSave={settings.saveSkill} onCancel={() => setSkillDraft(null)} /> : agent ? <AgentForm key={agent.id} initial={agent} tools={editorTools.tools} connections={editorTools.connections}
      onSave={draft => settings.saveAgent(draft)} onCancel={() => setAgentId(null)} />
      : entry ? <ExtensionDetail key={entry.source.installationId} entry={entry} onBack={onConfigured} onConfigureTools={() => setAgentId(settings.agents[0]?.id ?? null)} onEditAgent={setAgentId} onCreateSkill={() => setSkillDraft({ id: crypto.randomUUID(), label: '', description: '', execution: 'llm', agentId: settings.agents[0]?.id ?? '', systemPrompt: '', requiredToolIds: [] })} />
      : preview ? <InstallPreviewCard preview={preview} busy={busy} onBack={() => setPreview(null)} onInstall={() => void perform(async () => {
        await state.install(preview.requestedSource, preview.previewId)
        const installed = useExtensionStore.getState().catalog?.entries.find(entry => entry.source.canonicalPath === preview.entry.source.canonicalPath)
        if (!installed) throw new Error('Registered source is unavailable in the refreshed inventory.')
        setInstalledId(installed.source.installationId); setPreview(null)
      })} /> : <section className="settings-block"><h2>{choices.find(choice => choice.id === currentId)?.name ?? 'Extension unavailable'}</h2><p>Review the application-supplied source before registering it. Trust, configuration, and tool access are separate choices.</p><Button disabled={busy} onClick={() => void inspect()}>Review source</Button></section>}
    {entry && <p className="settings-hint">{statusLabel(entry)}. {entry.manifest?.id === imageManifest.id && 'Image authentication is separate from your AI model connection. Configuration does not verify your Codex login; the first explicit image request checks it.'}</p>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    {!agent && !skillDraft && <div className="settings-actions"><Button disabled={busy || state.busyInstallationId !== null} onClick={() => void next()}>Next extension</Button><Button disabled={busy || state.busyInstallationId !== null} onClick={() => { setPreview(null); setInstalledId(null); if (index + 1 < selected.length) setIndex(index + 1); else onConfigured() }}>Skip this extension</Button></div>}
  </div>
}
