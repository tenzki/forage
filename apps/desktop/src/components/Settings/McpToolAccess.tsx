import { useEffect, useRef, useState } from 'react'
import type { McpConnection } from '@forage/agent-runtime'
import { useSettingsStore } from '../../store/settingsStore'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { Button } from '../ui/Button'
import { SwitchFieldInput } from '../ui/SwitchFieldInput'

export function McpToolAccess({ connection, onDone }: { connection: McpConnection; onDone: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { panel.current?.focus(); panel.current?.scrollIntoView({ block: 'nearest' }) }, [])
  const agents = useSettingsStore((state) => state.agents)
  const settingsLoaded = useSettingsStore((state) => state.isLoaded)
  const [toolIds, setToolIds] = useState(connection.tools.map((tool) => tool.id))
  const [agentIds, setAgentIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setError(null)
    setBusy(true)
    try {
      if (!connection.enabled || connection.error || toolIds.some((id) => !connection.tools.some((tool) => tool.id === id))) throw new Error('This connection changed. Refresh its tools and try again.')
      await useSettingsStore.getState().grantMcpToolAccess(toolIds, agentIds)
      try { await publishLocalAgentConfiguration() }
      catch { throw new Error('Access was saved in Forage, but could not be published to the backend. Try again to publish it.') }
      onDone()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save tool access.') }
    finally { setBusy(false) }
  }
  return <div ref={panel} tabIndex={-1} className="custom-tool-form" role="group" aria-label={`Tool access for ${connection.name}`}>
    <strong>Choose agents for {connection.name}</strong>
    <p className="settings-hint">Review the tools and choose which agents can use them. Access is enabled when you save.</p>
    <fieldset disabled={busy}><legend>Tools to enable</legend>{connection.tools.map((tool) => <SwitchFieldInput key={tool.id} label={tool.name} hint={tool.description} checked={toolIds.includes(tool.id)} onCheckedChange={(checked) => setToolIds((ids) => checked ? [...ids, tool.id] : ids.filter((id) => id !== tool.id))} />)}</fieldset>
    <fieldset disabled={busy}><legend>Agents</legend>{agents.map((agent) => <SwitchFieldInput key={agent.id} label={agent.name} checked={agentIds.includes(agent.id)} onCheckedChange={(checked) => setAgentIds((ids) => checked ? [...ids, agent.id] : ids.filter((id) => id !== agent.id))} />)}</fieldset>
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="settings-actions"><Button variant="primary" disabled={busy || !settingsLoaded || !toolIds.length || !agentIds.length} onClick={() => void save()}>Enable for selected agents</Button><Button disabled={busy} onClick={onDone}>Done for now</Button></div>
  </div>
}
