import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { CredentialMetadata } from '@forage/protocol'
import { TauriServerAgentTransport } from '../../agent/serverExecutor'
import { useSettingsStore } from '../../store/settingsStore'
import type { ServerConnectionInfo } from '../../persistence/eventStore'
import { ConfirmButton } from './ConfirmButton'
import { SegmentedControl } from '../ui/SegmentedControl'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type ComputeMode = 'local' | 'server'
type WizardStep = 'connect' | 'verify' | 'credential' | 'publish'

const WIZARD_STEPS: Array<{ id: WizardStep; label: string }> = [
  { id: 'connect', label: 'Connect' },
  { id: 'verify', label: 'Verify' },
  { id: 'credential', label: 'Credential' },
  { id: 'publish', label: 'Publish' },
]

export function ComputeSettings() {
  const agents = useSettingsStore((state) => state.agents)
  const skills = useSettingsStore((state) => state.skills)
  const customTools = useSettingsStore((state) => state.customTools)
  const enabledToolIds = useSettingsStore((state) => state.enabledToolIds)

  // Local stays selected until the native side confirms an enrolled server.
  const [mode, setMode] = useState<ComputeMode>('local')
  const [connection, setConnection] = useState<ServerConnectionInfo | null>(null)
  const [step, setStep] = useState<WizardStep>('connect')
  const [origin, setOrigin] = useState('')
  const [outlineId, setOutlineId] = useState('')
  const [deviceToken, setDeviceToken] = useState('')
  const [verified, setVerified] = useState(false)
  const [credential, setCredential] = useState<CredentialMetadata | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [authorizationId, setAuthorizationId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const transport = new TauriServerAgentTransport()

  useEffect(() => {
    void invoke<ServerConnectionInfo | null>('server_connection_info')
      .then(async (value) => {
        if (!value) return
        setConnection(value)
        setMode('server')
        try {
          const published = await transport.configuration()
          setRevision(published.configuration.revision)
          const reference = published.configuration.agents.find((agent) => agent.credentialRef)?.credentialRef
          if (reference) setCredential(await transport.credential(reference))
        } catch { /* an unpublished server has no configuration yet */ }
      })
      .catch((error) => setStatus(message(error)))
  }, [])

  function startWizard() {
    setStatus(null)
    setMode('server')
    if (!connection) {
      setStep('connect')
      setVerified(false)
    }
  }

  function cancelWizard() {
    setStatus(null)
    setMode('local')
    setStep('connect')
    setDeviceToken('')
    setVerified(false)
  }

  async function enrollServer() {
    setBusy(true)
    setStatus(null)
    try {
      await invoke('server_enroll', {
        origin: origin.trim(),
        outlineId: outlineId.trim(),
        deviceToken: deviceToken.trim(),
      })
      setConnection(await invoke<ServerConnectionInfo>('server_connection_info'))
      setDeviceToken('')
      setStep('verify')
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function verifyServer() {
    setBusy(true)
    setStatus(null)
    try {
      await invoke('server_test_connection')
      setVerified(true)
      setStatus('Server connection verified.')
    } catch (error) { setVerified(false); setStatus(message(error)) } finally { setBusy(false) }
  }

  async function enrollApiKey() {
    setBusy(true)
    setStatus(null)
    try {
      setCredential(await transport.enrollApiKey({ provider: 'openai', apiKey: apiKey.trim() }))
      setApiKey('')
      setStatus('Server API key enrolled securely.')
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function connectChatGpt() {
    setBusy(true)
    setStatus(null)
    try {
      const authorization = await transport.startDeviceAuthorization()
      await openUrl(authorization.verificationUri)
      setAuthorizationId(authorization.authorizationId)
      setStatus(`Enter ${authorization.userCode} in the browser, then click Check ChatGPT login.`)
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function checkChatGpt() {
    if (!authorizationId) return setStatus('Start ChatGPT login first.')
    setBusy(true)
    try {
      const result = await transport.pollDeviceAuthorization(authorizationId)
      if (result.credential) setCredential(result.credential)
      setStatus(result.state === 'connected' ? 'Server ChatGPT credential connected.' : `ChatGPT login: ${result.state}`)
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function publishConfiguration() {
    if (!credential || credential.status !== 'connected') return setStatus('Connect a server credential before publishing.')
    setBusy(true)
    setStatus(null)
    try {
      const published = await transport.publishConfiguration({
        baseRevision: revision,
        configuration: {
          version: 1,
          revision: revision + 1,
          agents: agents.map((agent) => ({ ...agent, credentialRef: credential.id })),
          skills,
          customTools,
          globallyEnabledToolIds: enabledToolIds,
        },
      })
      setRevision(published.configuration.revision)
      setStatus('Server compute is ready. Restart Forage to load the server outline.')
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function testConnection() {
    setBusy(true)
    setStatus(null)
    try {
      await invoke('server_test_connection')
      setStatus('Server connection verified.')
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function useLocalCompute() {
    setBusy(true)
    setStatus(null)
    try {
      await invoke('server_disconnect')
      setConnection(null)
      setCredential(null)
      setRevision(0)
      setVerified(false)
      setStep('connect')
      setMode('local')
      setStatus('Local compute will be used after restart.')
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  const stepIndex = WIZARD_STEPS.findIndex((entry) => entry.id === step)
  const setupComplete = Boolean(connection) && revision > 0

  return (
    <div className="auth-card compute-settings">
      <strong>Compute</strong>
      <SegmentedControl
        ariaLabel="Compute location"
        value={mode}
        options={[
          { value: 'local', label: 'Local' },
          { value: 'server', label: 'Server' },
        ]}
        onValueChange={(nextMode) => {
          if (nextMode === 'server') startWizard()
          else if (connection) setMode('local')
          else cancelWizard()
        }}
      />

      {mode === 'local' ? (
        <>
          <p className="settings-hint">
            Notes and agent runs stay on this device. The event history lives in SQLite and never leaves the machine.
          </p>
          {connection && (
            <>
              <p className="settings-hint">Still enrolled with {connection.origin}. Disconnect to fall back to local compute.</p>
              <ConfirmButton
                label="Use local compute"
                confirmLabel="Confirm disconnect"
                ariaLabel="Use local compute"
                confirmAriaLabel="Confirm disconnecting the server"
                onConfirm={() => void useLocalCompute()}
              />
            </>
          )}
        </>
      ) : setupComplete ? (
        <>
          <p className="settings-hint">Runs continue on {connection?.origin} while this app is closed. Server mode never falls back to local execution.</p>
          <code>{connection?.outlineId}</code>
          <p className="settings-hint">Credential: {credential?.status ?? 'not enrolled'} · Configuration revision: {revision}</p>
          <div className="settings-actions">
            <button type="button" className="settings-save" disabled={busy} onClick={() => void testConnection()}>Test connection</button>
            <ConfirmButton
              label="Use local compute"
              confirmLabel="Confirm disconnect"
              ariaLabel="Use local compute"
              confirmAriaLabel="Confirm disconnecting the server"
              onConfirm={() => void useLocalCompute()}
            />
          </div>
        </>
      ) : (
        <div className="compute-wizard">
          <p className="settings-hint" data-testid="compute-wizard-progress">
            Step {stepIndex + 1} of {WIZARD_STEPS.length} · {WIZARD_STEPS[stepIndex]?.label}
          </p>
          <ol className="compute-wizard-steps">
            {WIZARD_STEPS.map((entry, index) => (
              <li key={entry.id} className={index === stepIndex ? 'active' : index < stepIndex ? 'done' : ''}>{entry.label}</li>
            ))}
          </ol>

          {step === 'connect' && (
            <>
              <p className="settings-hint">Point Forage at a self-hosted server. It becomes the source of truth for the outline and runs agents while this app is closed.</p>
              <label htmlFor="forage-server-origin">Server URL</label>
              <input id="forage-server-origin" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://notes.example.com" />
              <label htmlFor="forage-outline-id">Outline ID</label>
              <input id="forage-outline-id" value={outlineId} onChange={(event) => setOutlineId(event.target.value)} autoComplete="off" />
              <label htmlFor="forage-device-token">Device token</label>
              <input id="forage-device-token" type="password" value={deviceToken} onChange={(event) => setDeviceToken(event.target.value)} autoComplete="off" />
            </>
          )}

          {step === 'verify' && (
            <>
              <p className="settings-hint">Check that {connection?.origin} answers with the pinned certificate and accepts this device token.</p>
              <button type="button" className="settings-save" disabled={busy} onClick={() => void verifyServer()}>
                {verified ? 'Test again' : 'Test connection'}
              </button>
            </>
          )}

          {step === 'credential' && (
            <>
              <p className="settings-hint">The server needs its own OpenAI credential. It is stored server-side and never sent back to this device.</p>
              <label htmlFor="server-openai-key">Server OpenAI API key</label>
              <input id="server-openai-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" autoComplete="off" />
              <div className="settings-actions">
                <button type="button" className="settings-save" disabled={busy || apiKey.trim().length < 20} onClick={() => void enrollApiKey()}>Enroll API key</button>
                <button type="button" className="settings-secondary" disabled={busy} onClick={() => void connectChatGpt()}>Connect ChatGPT</button>
                <button type="button" className="settings-secondary" disabled={busy} onClick={() => void checkChatGpt()}>Check ChatGPT login</button>
              </div>
              <p className="settings-hint">Credential: {credential?.status ?? 'not enrolled'}</p>
            </>
          )}

          {step === 'publish' && (
            <>
              <p className="settings-hint">
                Publish the current agents, skills, and enabled tools so the server can run them. Later edits can be republished from Server agent executor below.
              </p>
              <button type="button" className="settings-save" disabled={busy || credential?.status !== 'connected'} onClick={() => void publishConfiguration()}>
                Publish agents and skills
              </button>
            </>
          )}

          <div className="settings-actions compute-wizard-actions">
            {stepIndex > 0 && (
              <button
                type="button"
                className="settings-secondary"
                disabled={busy}
                onClick={() => setStep(WIZARD_STEPS[stepIndex - 1]!.id)}
              >
                Back
              </button>
            )}
            {step === 'connect' && (
              <button
                type="button"
                className="settings-save"
                disabled={busy || !origin.trim() || !outlineId.trim() || !deviceToken.trim()}
                onClick={() => void enrollServer()}
              >
                Connect server
              </button>
            )}
            {step === 'verify' && (
              <button type="button" className="settings-save" disabled={busy || !verified} onClick={() => setStep('credential')}>Next</button>
            )}
            {step === 'credential' && (
              <button type="button" className="settings-save" disabled={busy || credential?.status !== 'connected'} onClick={() => setStep('publish')}>Next</button>
            )}
            <button type="button" className="settings-secondary" disabled={busy} onClick={cancelWizard}>Cancel</button>
          </div>
        </div>
      )}

      {status && <p role="status" className="settings-hint">{status}</p>}
    </div>
  )
}
