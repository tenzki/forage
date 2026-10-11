import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { MODEL_PROVIDERS } from '@forage/agent-runtime'
import { TauriServerAgentTransport } from '../../agent/serverExecutor'
import { useSettingsStore } from '../../store/settingsStore'
import { Button } from '../ui/Button'
import { useSettingsNavigation } from './settingsNavigation'

export function InheritedCompute() {
  const navigation = useSettingsNavigation()
  const localCompute = useSettingsStore((state) => state.localCompute)
  const [summary, setSummary] = useState('Loading inherited compute…')
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const mode = await invoke<'local' | 'server'>('event_store_storage_mode')
        const compute = mode === 'local' ? localCompute : mode === 'server' ? (await new TauriServerAgentTransport().computeProfile()).profile : null
        if (!compute) throw new Error('Unavailable')
        if (active) setSummary(`${mode === 'server' ? 'Server' : 'Local'} · ${MODEL_PROVIDERS.find((provider) => provider.id === compute.provider)?.label ?? 'Unsupported provider'} · ${compute.modelId}`)
      } catch { if (active) setSummary('Inherited compute is unavailable. Restore the connection or configure a default in Connection.') }
    })()
    return () => { active = false }
  }, [localCompute])
  return <div className="settings-block settings-inherited-compute" aria-label="Inherited compute"><p>{summary.startsWith('Inherited compute') ? summary : `Inherited compute · ${summary}`}</p><p className="settings-hint settings-footnote">Agents use the workspace default. Changes apply to future runs only.</p>{navigation && <Button variant="ghost" className="settings-text-link" onClick={() => navigation.select('connection')}>Change in Connection →</Button>}</div>
}
