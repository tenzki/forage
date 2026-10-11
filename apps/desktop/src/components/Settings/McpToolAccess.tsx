import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { McpConnection } from '@forage/agent-runtime'
import { useMcpStore } from '../../store/mcpStore'
import { useSettingsStore } from '../../store/settingsStore'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { Button } from '../ui/Button'
import { McpToolRow } from './McpToolRow'
import { mcpReviewIdentity } from './AgentMcpTools'
import { mcpSettingsError, mcpText } from './mcpPresentation'
import { useDraftExit } from './useDraftExit'

export function McpToolAccess({ connection, onDone, onCancel = onDone, onRefresh, refreshBusy = false, actions }: {
  connection: McpConnection; onDone: () => void; onCancel?: () => void; onRefresh?: () => void; refreshBusy?: boolean; actions?: ReactNode | ((busy: boolean) => ReactNode)
}) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { panel.current?.focus() }, [])
  const agents = useSettingsStore((state) => state.agents)
  const settingsLoaded = useSettingsStore((state) => state.isLoaded)
  const globallyEnabled = useSettingsStore((state) => state.enabledToolIds)
  const selectedTools = () => connection.tools.map((tool) => tool.id).filter((id) => useSettingsStore.getState().enabledToolIds.includes(id))
  const [toolIds, setToolIds] = useState(selectedTools)
  const [agentIds, setAgentIds] = useState<string[]>([])
  const [identity, setIdentity] = useState(() => mcpReviewIdentity(connection))
  const [baseline, setBaseline] = useState(() => JSON.stringify(selectedTools()))
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const savedSignature = useRef<string | null>(null)
  const changed = identity !== mcpReviewIdentity(connection)
  const unavailable = !connection.enabled || !!connection.error || connection.authorizationStatus === 'sign_in_required'
  const dirty = baseline !== JSON.stringify(toolIds) || agentIds.length > 0 || !!savedSignature.current
  const exit = useDraftExit(dirty, busy || refreshBusy, onCancel)
  const reviewCurrent = () => {
    setToolIds(selectedTools()); setAgentIds([]); setBaseline(JSON.stringify(selectedTools()))
    setIdentity(mcpReviewIdentity(connection)); setError(null); savedSignature.current = null
  }
  const save = async () => {
    if (saving.current) return
    saving.current = true
    setError(null); setBusy(true)
    try {
      const state = useMcpStore.getState()
      const current = (connection.environment === 'server' ? state.serverConnections : state.connections).find((entry) => entry.id === connection.id)
      if (!current || !current.enabled || current.error || current.authorizationStatus === 'sign_in_required' || identity !== mcpReviewIdentity(current)) throw new Error('This connection changed or was removed.')
      const signature = JSON.stringify({ identity, toolIds, agentIds })
      if (savedSignature.current !== signature) {
        await useSettingsStore.getState().grantMcpToolAccess(toolIds, agentIds, connection.tools.map((tool) => tool.id))
        savedSignature.current = signature
      }
      try { await publishLocalAgentConfiguration() }
      catch { throw new Error('Could not publish saved access.') }
      if (connection.environment === 'local' && current.authorizationStatus === 'review_required') await state.reviewAccess(connection.id)
      exit.allowExit(); onDone()
    } catch (cause) { setError(mcpSettingsError(cause, 'Could not save tool access. Check Connection and retry; this review remains open.')) }
    finally { saving.current = false; setBusy(false) }
  }
  return <div ref={panel} tabIndex={-1} className="custom-tool-form mcp-access-form" role="group" aria-label={`Tool access for ${mcpText(connection.name, 80)}`}>
    <div className="settings-page-heading"><h3>Tools</h3>{onRefresh && <Button disabled={busy || refreshBusy} onClick={onRefresh}>Refresh tools</Button>}</div>
    <p className="settings-hint">{toolIds.length} of {connection.tools.length} selected · Approved tools update automatically. New tools stay disabled until selected.</p>
    {unavailable && <p role="alert" className="settings-error">This connection is unavailable or disabled. Refresh or enable it before saving access.</p>}
    {changed && <div role="alert"><p>The tool inventory changed. No new access was granted. Review the current definitions before saving.</p><Button disabled={busy || refreshBusy || unavailable} onClick={reviewCurrent}>Review updated tools</Button></div>}
    {!connection.tools.length && <p className="settings-hint">This server provides no agent tools.</p>}
    <fieldset disabled={busy || refreshBusy || changed || unavailable} className="settings-row-list"><legend className="sr-only">Tools to enable</legend>{connection.tools.map((tool) => <McpToolRow key={tool.id} tool={tool} checked={toolIds.includes(tool.id)} disabled={busy || refreshBusy || changed || unavailable} onChange={(checked) => setToolIds((ids) => checked ? [...ids, tool.id] : ids.filter((id) => id !== tool.id))} />)}</fieldset>
    <fieldset className="settings-block mcp-agent-access" disabled={busy || refreshBusy || changed || unavailable}><legend>Agents</legend>
      <p className="settings-hint">Add the selected tools to these agents. Existing agent references are retained; remove individual grants in the agent editor.</p>
      {!agents.length && <p className="settings-hint">No agents configured. You can save global tool policy and assign agents later.</p>}
      <div className="settings-agent-choices">{agents.map((agent) => <label className="settings-agent-choice" data-selected={agentIds.includes(agent.id)} key={agent.id}>
        <input type="checkbox" aria-label={agent.name} checked={connection.authorizationStatus === 'sign_in_required' ? agent.toolIds.some((id) => connection.tools.some((tool) => tool.id === id) && globallyEnabled.includes(id)) : agentIds.includes(agent.id)} onChange={(event) => setAgentIds((ids) => event.target.checked ? [...ids, agent.id] : ids.filter((id) => id !== agent.id))} />
        <span>{agent.name}<span className="sr-only"> · {agent.toolIds.filter((id) => connection.tools.some((tool) => tool.id === id) && globallyEnabled.includes(id)).length} tools currently available</span></span>
      </label>)}</div>
    </fieldset>
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="settings-actions"><Button variant="primary" disabled={busy || refreshBusy || changed || unavailable || !settingsLoaded || (!toolIds.length && !!agentIds.length)} onClick={() => void save()}>Save access</Button><p className="settings-hint">{toolIds.length} {toolIds.length === 1 ? 'tool' : 'tools'} for {agentIds.length} {agentIds.length === 1 ? 'agent' : 'agents'}</p><Button disabled={busy || refreshBusy} onClick={exit.cancel}>Cancel</Button></div>
    {typeof actions === 'function' ? actions(busy || refreshBusy) : actions}
    {exit.dialog}
  </div>
}
