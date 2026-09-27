import { useState } from 'react'
import { mcpToolOptions, useMcpStore } from '../../store/mcpStore'
import { useSettingsStore } from '../../store/settingsStore'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { Button } from '../ui/Button'
import { SwitchFieldInput } from '../ui/SwitchFieldInput'
import { ConfirmButton } from './ConfirmButton'
import { McpConnectionForm } from './McpConnectionForm'
import { useMcpConnections } from './useMcpConnections'
import { McpDiscoveredConnections } from './McpDiscoveredConnections'
import { McpToolAccess } from './McpToolAccess'

export function McpSettings() {
  const state = useMcpStore()
  const enabledToolIds = useSettingsStore((settings) => settings.enabledToolIds)
  const settingsLoaded = useSettingsStore((settings) => settings.isLoaded)
  const { environment, connections, loading, error, reload } = useMcpConnections()
  const [actionError, setActionError] = useState<string | null>(null)
  const [accessId, setAccessId] = useState<string | null>(null)
  const perform = async (action: () => Promise<void>) => {
    setActionError(null)
    try { await action() } catch (error) { setActionError(error instanceof Error ? error.message : 'MCP operation failed.') }
  }
  return <section className="settings-section" aria-labelledby="mcp-heading">
    <h2 id="mcp-heading">MCP servers</h2>
    <p className="settings-hint">Connect MCP servers and choose which agents can use their tools.</p>
    {loading && <p className="settings-hint" role="status">Loading MCP servers…</p>}
    {!loading && !error && environment === 'local' && <>
      <McpDiscoveredConnections onConnected={(connection) => setAccessId(connection.id)} />
      <details><summary className="cursor-pointer text-sm">Advanced setup</summary><div className="mt-3"><McpConnectionForm /></div></details>
    </>}
    {!loading && environment === 'server' && <>
      <p className="settings-hint">Your agents run on your connected Forage server. Its MCP connections appear here automatically. Contact the server operator to add or update a connection.</p>
      <Button disabled={state.busy} onClick={reload}>Refresh tools</Button>
    </>}
    {!loading && !error && connections.length === 0 && <p className="settings-hint">No MCP servers connected yet.</p>}
    {connections.map((connection) => <div className="auth-card" key={connection.id}>
      <strong>{connection.name}</strong>
      <p className="settings-hint">{connection.error ?? `${connection.tools.length} tools discovered${connection.enabled ? '' : ' · Disabled'}`}</p>
      <Button className="self-start" disabled={state.busy || !connection.enabled || !!connection.error || !settingsLoaded || !connection.tools.length} onClick={() => setAccessId(connection.id)}>Choose agents</Button>
      {accessId === connection.id && <McpToolAccess connection={connection} onDone={() => setAccessId(null)} />}
      {environment === 'local' && <div className="settings-actions">
        <Button disabled={state.busy} onClick={() => void perform(async () => {
          await state.refresh(connection.id)
          await publishLocalAgentConfiguration()
        })}>Refresh tools</Button>
        <Button disabled={state.busy} onClick={() => void perform(() => state.setEnabled(connection.id, !connection.enabled))}>{connection.enabled ? 'Disable connection' : 'Enable connection'}</Button>
        <ConfirmButton label="Remove" confirmLabel="Confirm remove" variant="danger" disabled={state.busy} onConfirm={() => void perform(async () => {
          await state.remove(connection.id)
          await publishLocalAgentConfiguration()
        })} />
      </div>}
      {mcpToolOptions([connection]).map((tool) => <SwitchFieldInput key={tool.id}
        label={tool.name} hint={tool.description} checked={enabledToolIds.includes(tool.id)}
        disabled={state.busy || !tool.available || !settingsLoaded}
        switchAriaLabel={`Enable ${tool.name}`}
        onCheckedChange={(enabled) => void perform(async () => {
          await useSettingsStore.getState().setToolEnabled(tool.id, enabled)
          await publishLocalAgentConfiguration()
        })} />)}
    </div>)}
    {(actionError || error) && <p className="settings-error" role="alert">{actionError ?? error}</p>}
    {!loading && error && environment !== 'server' && <Button onClick={reload}>Try again</Button>}
  </section>
}
