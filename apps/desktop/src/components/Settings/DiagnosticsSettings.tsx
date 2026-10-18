import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getProviderModels } from '@forage/pi-runtime/provider-catalog'
import { probeCodexRuntime, probePiRuntime } from '../../agent/piSidecarClient'
import { TauriServerAgentTransport } from '../../agent/serverExecutor'
import { useSettingsStore } from '../../store/settingsStore'
import { Button } from '../ui/Button'
import { CircleCheck, CircleHelp, CircleAlert, LoaderCircle } from 'lucide-react'

type Check = { label: string; state: 'pending' | 'ready' | 'unavailable' | 'setup-required'; detail?: string }
const labels = ['Workspace connection', 'Outline sync', 'Model setup', 'Agent service', 'Search index', 'Node.js', 'Codex']

export function diagnosticVersion(value: string | undefined): string | undefined {
  return value && /^(?:(?:node|codex-cli) )?v?\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(value) ? value : undefined
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Unavailable')), 5000) })]) }
  finally { clearTimeout(timeout) }
}

export function DiagnosticsSettings({ onConnection }: { onConnection: () => void }) {
  const [checks, setChecks] = useState<Check[]>([])
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const generation = useRef(0)
  useEffect(() => () => { generation.current += 1 }, [])
  async function run() {
    if (busy) return
    const revision = ++generation.current
    setBusy(true)
    setCopied(false)
    setCopyError(false)
    setChecks(labels.map((label) => ({ label, state: 'pending' })))
    const nodeStatus = bounded(probePiRuntime())
    const update = (items: Check[]) => { if (generation.current === revision) setChecks((current) => current.map((check) => items.find((item) => item.label === check.label) ?? check)) }
    await Promise.allSettled([
      (async () => {
        try {
          const mode = await bounded(invoke<'local' | 'server'>('event_store_storage_mode'))
          if (mode === 'local') {
            const settings = useSettingsStore.getState()
            const account = settings.localCredentials.find((entry) => entry.id === settings.localCompute.credentialRef && entry.provider === settings.localCompute.provider && entry.status === 'connected')
            const modelAvailable = !!account && getProviderModels(settings.localCompute.provider).some((model) => model.id === settings.localCompute.modelId)
            update(labels.slice(0, 5).filter((label) => label !== 'Agent service').map((label) => ({ label, state: label === 'Model setup' && !modelAvailable ? 'setup-required' : 'ready' })))
            try { update([{ label: 'Agent service', state: (await nodeStatus).available ? 'ready' : 'unavailable' }]) }
            catch { update([{ label: 'Agent service', state: 'unavailable' }]) }
          } else if (mode === 'server') {
            const readiness = await bounded(new TauriServerAgentTransport().readiness())
            update([readiness.connection, readiness.outlineSync, readiness.computeProfile, readiness.worker, readiness.noteIndex].map((component, index) => ({ label: labels[index]!, state: component.ready ? 'ready' : 'setup-required' })))
          } else throw new Error('Unknown environment')
        } catch { update(labels.slice(0, 5).map((label) => ({ label, state: 'unavailable' }))) }
      })(),
      ...([['Node.js', nodeStatus], ['Codex', bounded(probeCodexRuntime())]] as const).map(async ([label, operation]) => {
        try { const status = await operation; update([{ label, state: status.available ? 'ready' : 'unavailable', detail: diagnosticVersion(status.version) }]) }
        catch { update([{ label, state: 'unavailable' }]) }
      }),
    ])
    if (revision === generation.current) setBusy(false)
  }
  const report = ['Forage diagnostics', ...checks.map((check) => `${check.label}: ${check.state}${check.detail ? ` (${check.detail})` : ''}`)].join('\n')
  return <section className="settings-section settings-editor diagnostics-settings" aria-labelledby="diagnostics-heading">
    <div className="settings-heading-copy"><h2 id="diagnostics-heading">Diagnostics</h2><p className="settings-hint">Check connections and collect details when something isn’t working.</p></div>
    <ul className="settings-row-list settings-diagnostic-results" aria-live="polite" aria-label="Diagnostic results">{labels.map((label) => {
      const check = checks.find((entry) => entry.label === label)
      const state = check?.state.replace('-', ' ') ?? 'not checked'
      const Icon = check?.state === 'ready' ? CircleCheck : check?.state === 'pending' ? LoaderCircle : check ? CircleAlert : CircleHelp
      return <li key={label} className="settings-diagnostic-row" aria-label={`${label}: ${state}`} data-state={check?.state ?? 'unchecked'}><Icon size={18} aria-hidden="true" /><div><p>{label}</p><p className="settings-hint">{state}</p></div></li>
    })}</ul>
    <div className="settings-actions"><Button variant="primary" disabled={busy} onClick={() => void run()}>{busy ? 'Checking…' : 'Run checks'}</Button><Button disabled={busy || !checks.length} onClick={() => void (async () => { try { await navigator.clipboard.writeText(report); setCopied(true) } catch { setCopyError(true) } })()}>{copied ? 'Copied report' : 'Copy sanitized report'}</Button></div>
    <p className="settings-hint settings-footnote">Independent checks do not run a model or expose credentials. A configured model account is not a live connectivity test.</p>
    <Button variant="ghost" className="settings-text-link" onClick={onConnection}>Open Connection settings</Button>
    <details className="settings-divider"><summary>Technical details</summary><p className="settings-hint">Runtime versions and connection checks for troubleshooting.</p><pre>{report}</pre><p className="settings-hint">Local agents require Node.js; subscription image generation additionally requires Codex. Server agents execute on the connected server.</p></details>
    <p className="settings-hint settings-footnote">Reports exclude API keys, tokens, and raw errors.</p>
    {copyError && <p role="alert">Could not copy the report. Select the text in Technical details instead.</p>}
  </section>
}
