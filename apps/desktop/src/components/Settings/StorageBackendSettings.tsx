import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ServerConnectionInfo } from '../../persistence/eventStore'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function StorageBackendSettings() {
  const [connection, setConnection] = useState<ServerConnectionInfo | null>(null)
  const [origin, setOrigin] = useState('')
  const [outlineId, setOutlineId] = useState('')
  const [deviceToken, setDeviceToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    void invoke<ServerConnectionInfo | null>('server_connection_info')
      .then((value) => setConnection(value ?? null))
      .catch((error) => setStatus(message(error)))
  }, [])

  async function connect() {
    setBusy(true)
    setStatus(null)
    try {
      await invoke('server_enroll', { origin: origin.trim(), outlineId: outlineId.trim(), deviceToken: deviceToken.trim() })
      const current = await invoke<ServerConnectionInfo>('server_connection_info')
      setConnection(current)
      setDeviceToken('')
      setStatus('Connected. Restart Forage to load the server outline.')
    } catch (error) {
      setStatus(message(error))
    } finally { setBusy(false) }
  }

  async function testConnection() {
    setBusy(true)
    setStatus(null)
    try {
      await invoke('server_test_connection')
      setStatus('Server connection verified.')
    } catch (error) { setStatus(message(error)) }
    finally { setBusy(false) }
  }

  async function useLocalStorage() {
    setBusy(true)
    setStatus(null)
    try {
      await invoke('server_disconnect')
      setConnection(null)
      setStatus('Local single-device storage will be used after restart.')
    } catch (error) { setStatus(message(error)) }
    finally { setBusy(false) }
  }

  return (
    <div className="auth-card storage-backend-settings">
      <strong>Notes storage</strong>
      {connection ? (
        <>
          <p className="settings-hint">Server mode · {connection.origin}</p>
          <code>{connection.outlineId}</code>
          <div className="settings-actions">
            <button type="button" className="settings-save" disabled={busy} onClick={() => void testConnection()}>Test server</button>
            <button type="button" className="settings-secondary" disabled={busy} onClick={() => void useLocalStorage()}>Use local storage</button>
          </div>
        </>
      ) : (
        <>
          <p className="settings-hint">Local mode stores the event history in SQLite on this device. Connect a self-hosted server to synchronize multiple machines.</p>
          <label htmlFor="forage-server-origin">Server URL</label>
          <input id="forage-server-origin" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://notes.example.com" />
          <label htmlFor="forage-outline-id">Outline ID</label>
          <input id="forage-outline-id" value={outlineId} onChange={(event) => setOutlineId(event.target.value)} autoComplete="off" />
          <label htmlFor="forage-device-token">Device token</label>
          <input id="forage-device-token" type="password" value={deviceToken} onChange={(event) => setDeviceToken(event.target.value)} autoComplete="off" />
          <button type="button" className="settings-save" disabled={busy || !origin.trim() || !outlineId.trim() || !deviceToken.trim()} onClick={() => void connect()}>Connect server</button>
        </>
      )}
      {status && <p role="status" className="settings-hint">{status}</p>}
    </div>
  )
}
