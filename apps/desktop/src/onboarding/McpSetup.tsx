import { useState } from 'react'
import { useMcpConnections } from '../components/Settings/useMcpConnections'
import { McpConnectionForm } from '../components/Settings/McpConnectionForm'
import { McpDiscoveredConnections } from '../components/Settings/McpDiscoveredConnections'
import { mcpText } from '../components/Settings/mcpPresentation'
import { Button } from '../components/ui/Button'

export function McpSetup() {
  const { connections, loading, error, reload } = useMcpConnections()
  const [adding, setAdding] = useState(false)
  return <div className="settings-block onboarding-mcp">
    <p className="settings-hint">Connect tools from apps and services you use. This is optional and doesn’t require an AI account.</p>
    {loading && <p role="status">Loading saved connections…</p>}
    {error && <div role="alert"><p>{error}</p><Button onClick={reload}>Retry</Button></div>}
    {!loading && !error && (adding ? <McpConnectionForm onConnected={() => setAdding(false)} onCancel={() => setAdding(false)} /> : <>
      <h2>Saved connections · {connections.length}</h2>
      {connections.map(connection => <div className="onboarding-summary-row" key={connection.id}><strong>{mcpText(connection.name, 80)}</strong><p className="settings-hint">{connection.error || connection.authorizationStatus === 'sign_in_required' ? 'Needs attention' : 'Connection saved'} · Tool access is configured in Settings → MCP servers.</p></div>)}
      {!connections.length && <p className="settings-hint">No servers connected yet.</p>}
      <Button className="self-start" onClick={() => setAdding(true)}>Add server</Button>
      <McpDiscoveredConnections scanOnMount={false} onConnected={() => undefined} />
    </>)}
    <p className="settings-hint">Connecting doesn’t grant tools or assistant access. Review permissions later in Settings → MCP servers.</p>
  </div>
}
