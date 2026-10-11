import { useEffect, useRef, useState } from 'react'
import { mcpConnectionAvailable, type McpConnection } from '@forage/agent-runtime'
import { CheckCircle2, Plug, Plus } from 'lucide-react'
import { useSettingsNavigation } from './settingsNavigation'
import { SettingsBackLink } from './SettingsBackLink'
import { useMcpStore } from '../../store/mcpStore'
import { useSettingsStore } from '../../store/settingsStore'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { Button } from '../ui/Button'
import { ConfirmButton } from './ConfirmButton'
import { McpConnectionForm } from './McpConnectionForm'
import { useMcpConnections } from './useMcpConnections'
import { McpDiscoveredConnections } from './McpDiscoveredConnections'
import { McpToolAccess } from './McpToolAccess'
import { mcpSettingsError, mcpText } from './mcpPresentation'
import { McpAuthorizationWaiting } from './McpAuthorizationWaiting'

export function McpSettings() {
  const state = useMcpStore()
  const enabledToolIds = useSettingsStore((settings) => settings.enabledToolIds)
  const agents = useSettingsStore((settings) => settings.agents)
  const { environment, connections, loading, error, reload } = useMcpConnections()
  const [actionError, setActionError] = useState<string | null>(null)
  const [accessId, setAccessId] = useState<string | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const [working, setWorking] = useState(false)
  const lastActive = useRef<McpConnection | null>(null)
  const navigation = useSettingsNavigation()
  const request = (action: () => void) => navigation ? navigation.requestLeave(action) : action()
  useEffect(() => () => { void useMcpStore.getState().cancelAuthorization() }, [environment])
  const close = () => {
    setAccessId(null); setSetupOpen(false); setPendingIds([])
    navigation?.back()
  }
  const review = (id: string) => request(() => {
    setSetupOpen(false); setAccessId(id); setPendingIds([])
    navigation?.open('mcp', 'review', () => { setAccessId(null); setPendingIds([]) }, id)
  })
  const connected = (entries: McpConnection[]) => {
    const first = entries[0]
    setSetupOpen(false)
    if (!first) { close(); return }
    setAccessId(first.id); setPendingIds(entries.slice(1).map((entry) => entry.id))
    if (navigation?.route.page === 'setup') navigation.restore({ section: 'mcp', page: 'review', entityId: first.id }, () => { setAccessId(null); setPendingIds([]) })
    else navigation?.open('mcp', 'review', () => { setAccessId(null); setPendingIds([]) }, first.id)
  }
  const done = () => {
    const next = pendingIds[0]
    if (!next) { close(); return }
    setAccessId(next); setPendingIds(pendingIds.slice(1))
    navigation?.restore({ section: 'mcp', page: 'review', entityId: next }, () => { setAccessId(null); setPendingIds([]) })
  }
  useEffect(() => {
    if (!loading && !error && accessId && !connections.some((connection) => connection.id === accessId)) {
      navigation?.clearGuard()
      setAccessId(null); setPendingIds([])
      navigation?.back()
      setActionError('This MCP connection is no longer available. Returned to MCP servers.')
    }
  }, [loading, error, accessId, connections, navigation])
  const perform = async (action: () => Promise<void>) => {
    setActionError(null); setWorking(true)
    try { await action() } catch (cause) { setActionError(mcpSettingsError(cause)) }
    finally { setWorking(false) }
  }
  const source = (connection: McpConnection) => {
    if (connection.environment === 'server') return 'Managed by the server operator'
    const candidate = state.discovery?.candidates.find((entry) => entry.id === connection.discoveryId)
    return candidate ? `Added from ${candidate.sources.map((label) => mcpText(label, 80)).join(', ')}` : connection.discoveryId ? 'Imported from device configuration' : 'Added manually'
  }
  const current = connections.find((connection) => connection.id === accessId)
  if (current) lastActive.current = current
  const active = current ?? (loading && lastActive.current?.id === accessId ? lastActive.current : null)
  const busy = state.busy || working || loading
  const summary = (connection: McpConnection) => connection.authorizationStatus === 'sign_in_required' ? 'Sign-in required · Saved access is unavailable' : connection.authorizationStatus === 'review_required' ? 'Review access required · Saved selections are not active' : connection.error ? 'Unavailable · Refresh to reconnect' : !connection.enabled ? 'Disabled' : `Connected · ${connection.tools.filter((tool) => enabledToolIds.includes(tool.id)).length} of ${connection.tools.length} tools enabled`
  return <section className="settings-section mcp-settings" aria-labelledby="mcp-heading">
    {!navigation && (setupOpen || active) && <SettingsBackLink label="MCP servers" disabled={busy} onBack={() => request(close)} />}
    <div className={`settings-page-heading${active ? ' mcp-detail-heading' : ''}`}>
      {active && <span className="settings-server-icon"><Plug size={20} aria-hidden="true" /></span>}
      <div className="settings-inventory-copy"><h2 id="mcp-heading">{setupOpen ? 'Add an MCP server' : active ? mcpText(active.name, 80) : 'MCP servers'}</h2>
        {setupOpen ? <p className="settings-hint">Use the connection details from the server’s setup guide.</p> : !active && <p className="settings-hint">Connect tools from the apps and services you use.</p>}
      </div>
      {active && <span className="settings-connection-status">{active.authorizationStatus === 'sign_in_required' ? 'Sign-in required' : active.authorizationStatus === 'review_required' ? 'Review access' : active.error ? 'Unavailable' : active.enabled ? 'Connected' : 'Disabled'}</span>}
      {!setupOpen && !accessId && !loading && !error && (environment === 'local' ? <Button id="add-mcp-server" variant="primary" icon={<Plus />} onClick={() => request(() => { setSetupOpen(true); navigation?.open('mcp', 'setup', () => setSetupOpen(false)) })}>Add server</Button> : <Button disabled={busy} onClick={reload}>Refresh tools</Button>)}
    </div>
    {loading && <p className="settings-hint" role="status">Loading MCP servers…</p>}
    {environment === 'server' && <p className="settings-hint">Your agents run on your connected Forage server. Contact the server operator to add or update a connection. Device discovery and executable configuration are not available here.</p>}
    {!loading && !error && setupOpen && environment === 'local' && <McpConnectionForm onConnected={connected} onCancel={close} />}
    {!error && active && <>
      <div className="settings-connection-info"><CheckCircle2 size={16} aria-hidden="true" /><p className="settings-hint">{source(active)} · {summary(active)}</p></div>
      {active.authentication === 'oauth' && active.authorizationStatus === 'connected' && !active.tools.some((tool) => enabledToolIds.includes(tool.id)) && <div className="settings-block"><h3>Browser sign-in complete</h3><p className="settings-hint">Authorization saved on this device. No tools have access yet.</p></div>}
      {environment === 'local' && active.authentication === 'oauth' && <>
        {state.authorizationProgress ? <McpAuthorizationWaiting progress={state.authorizationProgress} onCancel={() => void state.cancelAuthorization()} /> : active.authorizationStatus === 'sign_in_required' ? <div className="settings-block mcp-authorization-state"><h3>Sign in again to use this server</h3><p className="settings-hint">Your saved tool and agent selections are retained, but unavailable. After signing in, review and save access before agents can use them again.</p><Button variant="primary" disabled={busy} onClick={() => void perform(async () => { await state.signIn(active.id) })}>Sign in again</Button></div> : active.authorizationStatus === 'review_required' ? <p className="settings-hint" role="status">Sign-in complete. Review your saved selections and choose Save access to activate them for this account.</p> : <Button disabled={busy} onClick={() => void perform(async () => { await state.signIn(active.id) })}>Sign in again</Button>}
      </>}
      <McpToolAccess key={active.id} connection={active} onDone={done} onCancel={close} refreshBusy={busy}
        onRefresh={() => environment === 'server' ? reload() : void perform(async () => { await state.refresh(active.id); await publishLocalAgentConfiguration() })}
        actions={(saving) => <details><summary>Connection details</summary><p className="settings-hint">Connection identity: {mcpText(active.id, 80)} · {source(active)}</p>
          {environment === 'local' && <div className="settings-actions">
            <Button disabled={busy || saving} onClick={() => void perform(() => state.setEnabled(active.id, !active.enabled))}>{active.enabled ? 'Disable connection' : 'Enable connection'}</Button>
            <ConfirmButton label="Disconnect" confirmLabel="Confirm disconnect" variant="danger" disabled={busy || saving} onConfirm={() => void perform(async () => { await state.remove(active.id); await publishLocalAgentConfiguration() })} />
          </div>}
        </details>} />
      {pendingIds.length > 0 && <p className="settings-hint">{pendingIds.length} more imported connections to review. Cancelling leaves them connected without new grants.</p>}
    </>}
    {!loading && !error && !setupOpen && !accessId && <>
      <section className="settings-block" aria-labelledby="mcp-connected-heading"><h3 id="mcp-connected-heading">Connected · {connections.length}</h3>
        {!connections.length && <p className="settings-hint">No MCP servers connected yet.</p>}
        <div className={connections.length ? 'settings-row-list' : undefined}>
        {connections.map((connection) => {
          const availableAgents = agents.filter((agent) => agent.toolIds.some((id) => enabledToolIds.includes(id) && mcpConnectionAvailable(connection) && connection.tools.some((tool) => tool.id === id)))
          return <div className="settings-inventory-row" role="group" aria-label={`Connected ${mcpText(connection.name, 80)}`} key={connection.id}>
            <span className="settings-server-icon"><Plug size={20} aria-hidden="true" /></span>
            <div className="settings-inventory-copy"><strong>{mcpText(connection.name, 80)}</strong>
            <p className="settings-hint">{source(connection)} · {summary(connection)}</p>
            <p className="settings-hint">{availableAgents.length ? `Available to ${availableAgents.map((agent) => agent.name).join(', ')}` : 'No agents have effective access'}</p>
            </div><Button id={`review-mcp-${connection.id}`} disabled={busy} onClick={() => review(connection.id)}>Manage</Button>
          </div>
        })}
        </div></section>
      {environment === 'local' && <McpDiscoveredConnections onConnected={(connection) => connected([connection])} />}
      <div className="settings-block settings-divider"><p className="settings-hint">Use Add server for a server URL, launch command, or JSON configuration.</p><p className="settings-hint">Forage connects servers where your agents run.</p></div>
    </>}
    {(actionError || error) && <p className="settings-error" role="alert">{actionError ?? error}</p>}
    {!loading && error && <Button onClick={reload}>Try again</Button>}
  </section>
}
