import { useEffect, useState } from 'react'
import type { McpCandidate, McpConnection } from '@forage/agent-runtime'
import { useMcpStore } from '../../store/mcpStore'
import { Button } from '../ui/Button'
import { Field, Input } from '../ui/Field'
import { Plug } from 'lucide-react'
import { mcpSettingsError, mcpText } from './mcpPresentation'

function Candidate({ candidate, onConnected }: { candidate: McpCandidate; onConnected: (connection: McpConnection) => void }) {
  const busy = useMcpStore((state) => state.busy)
  const connections = useMcpStore((state) => state.connections)
  const imported = connections.some((connection) => connection.discoveryId === candidate.id)
  const [name, setName] = useState(candidate.name)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const connect = async () => {
    setError(null)
    setConnecting(true)
    try {
      const connection = await useMcpStore.getState().connectCandidate(candidate.id, values, name)
      setValues({})
      onConnected(connection)
    } catch (cause) { setError(mcpSettingsError(cause, 'Could not connect. Check required credentials and the source setup; then retry or use Add server.')) }
    finally { setConnecting(false) }
  }
  return <div className="settings-inventory-row" role="group" aria-label={`Found ${candidate.name}`}>
    <span className="settings-server-icon is-detected"><Plug size={20} aria-hidden="true" /></span>
    <div className="settings-inventory-copy"><strong>{mcpText(candidate.name, 80)}</strong>
    <p className="settings-hint">Found in {candidate.sources.join(', ')} · {candidate.transport === 'stdio' ? 'Runs on this computer' : 'Remote server'}</p>
    {candidate.issue ? <p className="settings-hint">{mcpText(candidate.issue, 500)} Use Add server with a supported configuration.</p> : imported ? <p role="status" className="settings-hint">Already connected</p> : <>
      {candidate.inputs.length > 0 && <p className="settings-hint">This connection needs credentials that could not be reused. Enter the complete values below; they will be saved only in Forage’s local credential store.</p>}
      {candidate.inputs.map((field) => <Field key={field.key} label={field.label}><Input type="password" value={values[field.key] ?? ''} autoComplete="off" disabled={busy || connecting} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} /></Field>)}
      <details className="settings-candidate-options"><summary>Connection name</summary><p className="settings-hint">Definition {candidate.id.slice(0, 8)}</p><Field label="Name in Forage" className="mt-2"><Input value={name} maxLength={80} disabled={busy || connecting} onChange={(event) => setName(event.target.value)} /></Field></details>
    </>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    </div>
    {!candidate.issue && !imported && <Button disabled={busy || connecting || !name.trim() || candidate.inputs.some((field) => !values[field.key])} onClick={() => void connect()}>{connecting ? 'Connecting…' : 'Connect'}</Button>}
  </div>
}

export function McpDiscoveredConnections({ onConnected }: { onConnected: (connection: McpConnection) => void }) {
  const { discovery, scanning, discoveryError, busy, scanConnections, connections } = useMcpStore()
  const candidates = discovery?.candidates.filter((candidate) => !connections.some((connection) => connection.discoveryId === candidate.id)) ?? []
  useEffect(() => { void useMcpStore.getState().scanConnections().catch(() => undefined) }, [])
  return <div className="settings-block settings-divider" aria-labelledby="mcp-found-heading">
    <div className="settings-page-heading"><h3 id="mcp-found-heading">Detected on this computer · {candidates.length}</h3><Button disabled={scanning || busy} onClick={() => void scanConnections().catch(() => undefined)}>Scan again</Button></div>
    <p className="settings-hint">Connect servers you already use in other apps.</p>
    {scanning && <p role="status" className="settings-hint">Looking for MCP connections…</p>}
    {discoveryError && <p role="alert" className="settings-error">{mcpSettingsError(new Error(discoveryError), 'Could not scan device configurations. Existing connections remain available; try Scan again or Add server.')}</p>}
    <div className={candidates.length ? 'settings-row-list' : undefined}>{candidates.map((candidate) => <Candidate key={candidate.id} candidate={candidate} onConnected={onConnected} />)}</div>
    <p className="settings-hint">You’ll choose tools and agent access after connecting.</p>
    <p className="settings-hint">Scanning reads settings only. Connecting can run commands or download packages with your permissions; connect only sources you trust.</p>
    {discovery && !candidates.length && <p className="settings-hint">No unconnected servers detected. Use Add server for a URL, command, or JSON configuration.</p>}
    {!!discovery?.warnings.length && <p className="settings-hint">Discovery is incomplete. Some configurations could not be fully read; existing connections remain available.</p>}
    {discovery?.warnings.map((warning) => <p className="settings-hint" key={warning}>{mcpText(warning, 300)}</p>)}
  </div>
}
