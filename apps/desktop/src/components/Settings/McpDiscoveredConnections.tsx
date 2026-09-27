import { useEffect, useState } from 'react'
import type { McpCandidate, McpConnection } from '@forage/agent-runtime'
import { useMcpStore } from '../../store/mcpStore'
import { Button } from '../ui/Button'
import { Field, Input } from '../ui/Field'

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
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not connect.') }
    finally { setConnecting(false) }
  }
  return <div className="auth-card" role="group" aria-label={`Found ${candidate.name}`}>
    <strong>{candidate.name}</strong>
    <p className="settings-hint">Found in {candidate.sources.join(', ')} · {candidate.transport === 'stdio' ? 'Runs on this computer' : 'Remote server'}</p>
    {candidate.issue ? <p className="settings-hint">{candidate.issue}</p> : imported ? <p role="status" className="settings-hint">Already connected</p> : <>
      {candidate.inputs.length > 0 && <p className="settings-hint">This connection needs credentials that could not be reused. Enter the complete values below; they will be saved only in Forage’s local credential store.</p>}
      {candidate.inputs.map((field) => <Field key={field.key} label={field.label}><Input type="password" value={values[field.key] ?? ''} autoComplete="off" disabled={busy || connecting} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} /></Field>)}
      <details><summary className="cursor-pointer text-sm">Connection name</summary><Field label="Name in Forage" className="mt-2"><Input value={name} maxLength={80} disabled={busy || connecting} onChange={(event) => setName(event.target.value)} /></Field></details>
      <Button variant="primary" className="self-start" disabled={busy || connecting || !name.trim() || candidate.inputs.some((field) => !values[field.key])} onClick={() => void connect()}>{connecting ? 'Connecting…' : 'Connect'}</Button>
    </>}
    {error && <p role="alert" className="settings-error">{error}</p>}
  </div>
}

export function McpDiscoveredConnections({ onConnected }: { onConnected: (connection: McpConnection) => void }) {
  const { discovery, scanning, discoveryError, busy, scanConnections } = useMcpStore()
  useEffect(() => { void useMcpStore.getState().scanConnections().catch(() => undefined) }, [])
  return <div className="flex flex-col gap-3" aria-labelledby="mcp-found-heading">
    <div className="settings-actions"><h3 id="mcp-found-heading">Found on your computer</h3><Button disabled={scanning || busy} onClick={() => void scanConnections().catch(() => undefined)}>Scan again</Button></div>
    <p className="settings-hint">Find connections configured in Codex, Claude, Cursor, and VS Code. Scanning reads settings only. Connecting can run installed commands or download packages with your permissions; connect only sources you trust.</p>
    {scanning && <p role="status" className="settings-hint">Looking for MCP connections…</p>}
    {discoveryError && <p role="alert" className="settings-error">{discoveryError}</p>}
    {discovery?.candidates.map((candidate) => <Candidate key={candidate.id} candidate={candidate} onConnected={onConnected} />)}
    {discovery && !discovery.candidates.length && <p className="settings-hint">No connections found. You can still add any MCP server using advanced setup.</p>}
    {discovery?.warnings.map((warning) => <p className="settings-hint" key={warning}>{warning}</p>)}
  </div>
}
