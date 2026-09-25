import { useEffect, useState } from 'react'
import type { CredentialMetadata } from '@forage/protocol'
import { TauriServerAgentTransport } from '../../agent/serverExecutor'
import { republishLocalAgentConfiguration, usePublishedServerConfiguration } from '../../agent/serverConfigurationSync'
import type { ServerConnectionInfo } from '../../persistence/eventStore'
import { invoke } from '@tauri-apps/api/core'
import { InboxLinkRules } from './InboxLinkRules'
import { Button } from '../ui/Button'

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export function ServerAgentSettings() {
  const published = usePublishedServerConfiguration((state) => state.configuration)
  const [connection, setConnection] = useState<ServerConnectionInfo | null>(null)
  const [credential, setCredential] = useState<CredentialMetadata | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [transport] = useState(() => new TauriServerAgentTransport())
  const revision = published?.revision ?? 0

  useEffect(() => {
    void invoke<ServerConnectionInfo | null>('server_connection_info').then(async (value) => {
      setConnection(value)
      if (!value) return
      try {
        usePublishedServerConfiguration.getState().accept((await transport.configuration()).configuration)
        const compute = await transport.computeProfile()
        setCredential(await transport.credential(compute.profile.credentialRef))
      } catch { /* the first publication starts at revision zero */ }
    }).catch((error) => setStatus(message(error)))
  }, [])

  async function publishConfiguration() {
    setBusy(true); setStatus(null)
    try {
      const configuration = await republishLocalAgentConfiguration({ transport })
      setStatus(`Published server agent configuration revision ${configuration.revision}.`)
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function disconnectCredential() {
    if (!credential) return
    setBusy(true)
    try { setCredential(await transport.disconnectCredential(credential.id)); setStatus('Server credential disconnected.') }
    catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  if (!connection) return null
  return (
    <section className="settings-section server-agent-section" aria-labelledby="server-agent-heading">
      <div className="auth-card server-agent-settings">
        <h2 id="server-agent-heading">Server agent executor</h2>
        <p className="settings-hint">Runs continue on {connection.origin} while this app is closed. Server mode never falls back to local execution.</p>
        <p className="settings-hint">Configuration revision: {revision || 'not published'} · Credential: {credential?.status ?? 'not enrolled'}</p>
        <p className="settings-hint">Agent and skill changes publish to the server when you save them.</p>
        <div className="settings-actions">
          <Button variant="primary" disabled={busy || credential?.status !== 'connected'} onClick={() => void publishConfiguration()}>Republish agents and skills</Button>
          {credential?.status === 'connected' && <Button disabled={busy} onClick={() => void disconnectCredential()}>Disconnect credential</Button>}
        </div>
        <hr />
        <InboxLinkRules skills={published?.skills ?? []} transport={transport} canPublish={revision > 0} />
        {status && <p role="status" className="settings-hint">{status}</p>}
      </div>
    </section>
  )
}
