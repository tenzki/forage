import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { CredentialMetadata } from '@forage/protocol'
import type { PortableAgentConfiguration } from '@forage/agent-runtime'
import { TauriServerAgentTransport } from '../../agent/serverExecutor'
import {
  buildServerAgentConfiguration,
  isMissingServerAgentConfiguration,
} from '../../agent/serverConfiguration'
import {
  confirmedConfigurationMirror,
  NativeConfigurationMirrorStore,
  reconcileConfiguration,
} from '../../agent/configurationMirror'
import {
  firstIncompleteProvisioningStep,
  NativeServerProvisioningStore,
  type ServerProvisioningState,
  type ServerProvisioningStep,
} from '../../agent/serverProvisioning'
import { useSettingsStore } from '../../store/settingsStore'
import { NativeEventRepository, type ServerConnectionInfo } from '../../persistence/eventStore'
import { adoptLocalOutline } from '../../sync/adoptOutline'
import { serverRunManager } from '../../agent/serverRunManager'
import { usePublishedServerConfiguration } from '../../agent/serverConfigurationSync'
import { ConfirmButton } from './ConfirmButton'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Button } from '../ui/Button'
import { Field, Input } from '../ui/Field'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type ComputeMode = 'local' | 'server'
type WizardStep = 'connect' | 'copy' | 'verify' | 'credential'

const WIZARD_STEPS: Array<{ id: WizardStep; label: string }> = [
  { id: 'connect', label: 'Connect' },
  { id: 'copy', label: 'Copy' },
  { id: 'verify', label: 'Verify' },
  { id: 'credential', label: 'Credential' },
]

export function ComputeSettings() {
  const agents = useSettingsStore((state) => state.agents)
  const skills = useSettingsStore((state) => state.skills)
  const customTools = useSettingsStore((state) => state.customTools)
  const enabledToolIds = useSettingsStore((state) => state.enabledToolIds)
  const modelId = useSettingsStore((state) => state.modelId)
  const isLoaded = useSettingsStore((state) => state.isLoaded)
  const replaceAgentConfiguration = useSettingsStore((state) => state.replaceAgentConfiguration)

  // Local stays selected until the native side confirms an enrolled server.
  const [mode, setMode] = useState<ComputeMode>('local')
  const [wizardActive, setWizardActive] = useState(false)
  const [connection, setConnection] = useState<ServerConnectionInfo | null>(null)
  const [step, setStep] = useState<WizardStep>('connect')
  const [origin, setOrigin] = useState('')
  const [deviceToken, setDeviceToken] = useState('')
  const [alreadySeeded, setAlreadySeeded] = useState(false)
  const [verified, setVerified] = useState(false)
  const [credential, setCredential] = useState<CredentialMetadata | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [authorizationId, setAuthorizationId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [computeCredentialRef, setComputeCredentialRef] = useState<string | null>(null)
  const [computeRevision, setComputeRevision] = useState(0)
  const [outlineCopied, setOutlineCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [configurationConflict, setConfigurationConflict] = useState<PortableAgentConfiguration | null>(null)
  const [readiness, setReadiness] = useState<Awaited<ReturnType<TauriServerAgentTransport['readiness']>> | null>(null)
  const [provisioning, setProvisioning] = useState<ServerProvisioningState | null>(null)

  const transport = new TauriServerAgentTransport()
  const localAgentConfiguration = { agents, skills, customTools, enabledToolIds, modelId }

  useEffect(() => {
    if (!isLoaded) return
    void invoke<ServerConnectionInfo | null>('server_connection_info')
      .then(async (value) => {
        if (!value) return
        setConnection(value)
        setMode('server')
        try {
          const saved = await new NativeServerProvisioningStore().load()
          if (saved?.instanceId === value.instanceId && saved.outlineId === value.outlineId) {
            setProvisioning(saved)
            const incomplete = firstIncompleteProvisioningStep(saved)
            if (incomplete) {
              setWizardActive(true)
              setStep(incomplete === 'compute' ? 'credential' : 'copy')
            }
          }
        } catch { /* older native builds have no resumable provisioning state */ }
        try {
          let published = await transport.configuration()
          const local = buildServerAgentConfiguration(localAgentConfiguration, published.configuration.revision)
          const mirrorStore = new NativeConfigurationMirrorStore()
          const reconciliation = await reconcileConfiguration(
            local,
            published.configuration,
            await mirrorStore.load().catch(() => null),
          )
          if (reconciliation.outcome === 'publish_local') {
            published = await transport.publishConfiguration({
              baseRevision: published.configuration.revision,
              configuration: { ...local, revision: published.configuration.revision + 1 },
            })
          } else if (reconciliation.outcome === 'use_server') {
            await replaceAgentConfiguration(published.configuration)
          } else if (reconciliation.outcome === 'conflict') {
            setConfigurationConflict(published.configuration)
          }
          setRevision(published.configuration.revision)
          usePublishedServerConfiguration.getState().accept(published.configuration)
          if (reconciliation.outcome !== 'conflict') {
            await mirrorStore.save(await confirmedConfigurationMirror(published.configuration))
          }
          try {
            const compute = await transport.computeProfile()
            setComputeRevision(compute.profile.revision)
            setComputeCredentialRef(compute.profile.credentialRef)
            const serverCredential = await transport.credential(compute.profile.credentialRef)
            setCredential(serverCredential)
          } catch { /* outline synchronization remains usable without server compute */ }
          try { setReadiness(await transport.readiness()) } catch { /* show the known component state */ }
        } catch (error) {
          if (isMissingServerAgentConfiguration(error)) setStep('copy')
          else setStatus(message(error))
        }
      })
      .catch((error) => setStatus(message(error)))
  }, [isLoaded])

  function startWizard() {
    setStatus(null)
    setMode('server')
    setWizardActive(true)
    if (!connection) {
      setStep('connect')
      setVerified(false)
    }
  }

  function cancelWizard() {
    setStatus(null)
    setMode('local')
    setWizardActive(false)
    setStep('connect')
    setDeviceToken('')
    setAlreadySeeded(false)
    setVerified(false)
  }

  async function enrollServer() {
    setBusy(true)
    setStatus(null)
    try {
      await invoke('server_enroll', {
        origin: origin.trim(),
        deviceToken: deviceToken.trim(),
      })
      const enrolledConnection = await invoke<ServerConnectionInfo>('server_connection_info')
      setConnection(enrolledConnection)
      const store = new NativeServerProvisioningStore()
      let progress = await store.start(enrolledConnection.instanceId, enrolledConnection.outlineId)
      progress = await store.complete(progress, 'connection')
      setProvisioning(progress)
      setDeviceToken('')
      setStep('copy')
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function copyOutline() {
    setBusy(true)
    setStatus(null)
    try {
      const repository = new NativeEventRepository()
      const identity = await repository.identity()
      const result = await adoptLocalOutline(repository, identity.outlineId, (progress) => {
        setStatus(
          progress.phase === 'replaying' ? 'Reading the local outline…'
            : progress.phase === 'seeding'
              ? progress.assetCount
                ? `Uploading ${progress.assetCount} image(s), then the outline…`
                : 'Uploading the outline…'
              : 'Finishing up…',
        )
      })
      setOutlineCopied(true)
      setStatus('Syncing agents, skills, and tool settings…')
      await publishLocalConfiguration()
      await completeProvisioningSteps('outline', 'synchronization', 'configuration', 'mirror')
      await invoke('event_store_set_storage_mode', { mode: 'server' })
      setStatus(`Copied the outline and ${result.assetCount} image(s), then synced agent settings. Restart Forage to finish switching.`)
      setStep('verify')
    } catch (error) {
      const text = message(error)
      // A server that already holds an outline cannot take this device's content.
      if (/already been seeded|already holds an outline/i.test(text)) setAlreadySeeded(true)
      setStatus(text)
    } finally { setBusy(false) }
  }

  async function useServerOutline() {
    setBusy(true)
    setStatus(null)
    try {
      let published
      try {
        published = await transport.configuration()
        await replaceAgentConfiguration(published.configuration)
      } catch (error) {
        if (!isMissingServerAgentConfiguration(error)) throw error
        published = await publishLocalConfiguration()
      }
      setRevision(published.configuration.revision)
      await new NativeConfigurationMirrorStore().save(await confirmedConfigurationMirror(published.configuration))
      await completeProvisioningSteps('outline', 'synchronization', 'configuration', 'mirror')
      try {
        const compute = await transport.computeProfile()
        setComputeRevision(compute.profile.revision)
        setComputeCredentialRef(compute.profile.credentialRef)
        setCredential(await transport.credential(compute.profile.credentialRef))
      } catch { setCredential(null) }
      await invoke('event_store_set_storage_mode', { mode: 'server' })
      setStatus('This device will load the server outline after a restart. Agent settings are synced.')
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
      const enrolled = await transport.enrollApiKey({ provider: 'openai', apiKey: apiKey.trim() })
      setCredential(enrolled)
      setApiKey('')
      if (revision === 0) await publishLocalConfiguration()
      await publishCompute(enrolled)
      await completeProvisioningSteps('compute')
      setWizardActive(false)
      setStatus('Server API key enrolled and all agent settings synced. Server compute is ready.')
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
      if (result.credential) {
        setCredential(result.credential)
        if (revision === 0) await publishLocalConfiguration()
        await publishCompute(result.credential)
        await completeProvisioningSteps('compute')
        setWizardActive(false)
      }
      setStatus(result.state === 'connected' ? 'Server ChatGPT credential connected and all agent settings synced. Server compute is ready.' : `ChatGPT login: ${result.state}`)
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function publishLocalConfiguration() {
    const published = await transport.publishConfiguration({
      baseRevision: revision,
      configuration: buildServerAgentConfiguration({
        agents, skills, customTools, enabledToolIds, modelId,
      }, revision + 1),
    })
    setRevision(published.configuration.revision)
    usePublishedServerConfiguration.getState().accept(published.configuration)
    await new NativeConfigurationMirrorStore().save(await confirmedConfigurationMirror(published.configuration))
    setConfigurationConflict(null)
    return published
  }

  async function completeProvisioningSteps(...steps: ServerProvisioningStep[]) {
    if (!provisioning) return
    const store = new NativeServerProvisioningStore()
    let progress = provisioning
    for (const step of steps) progress = await store.complete(progress, step)
    setProvisioning(progress)
  }

  async function skipServerCompute() {
    if (provisioning) setProvisioning(await new NativeServerProvisioningStore().skipCompute(provisioning))
    setWizardActive(false)
    setStatus('Outline sync remains active. Server agents are disabled until compute is configured.')
  }

  async function resolveConfigurationConflict(choice: 'local' | 'server') {
    if (!configurationConflict) return
    setBusy(true)
    setStatus(null)
    try {
      if (choice === 'local') {
        const published = await transport.publishConfiguration({
          baseRevision: configurationConflict.revision,
          configuration: buildServerAgentConfiguration(localAgentConfiguration, configurationConflict.revision + 1),
        })
        setRevision(published.configuration.revision)
        usePublishedServerConfiguration.getState().accept(published.configuration)
        await new NativeConfigurationMirrorStore().save(await confirmedConfigurationMirror(published.configuration))
      } else {
        await replaceAgentConfiguration(configurationConflict)
        setRevision(configurationConflict.revision)
        usePublishedServerConfiguration.getState().accept(configurationConflict)
        await new NativeConfigurationMirrorStore().save(await confirmedConfigurationMirror(configurationConflict))
      }
      setConfigurationConflict(null)
      setStatus(choice === 'local' ? 'Published this device’s agent configuration.' : 'Applied the server agent configuration to this device.')
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function publishCompute(serverCredential: CredentialMetadata) {
    if (serverCredential.status !== 'connected') throw new Error('The selected server credential is not connected.')
    const compute = await transport.publishComputeProfile({
      baseRevision: computeRevision,
      profile: {
        version: 1, revision: computeRevision + 1, provider: serverCredential.provider,
        modelId, credentialRef: serverCredential.id,
      },
    })
    setComputeRevision(compute.profile.revision)
    setComputeCredentialRef(compute.profile.credentialRef)
    return compute
  }

  async function retryAgentSettingsSync() {
    if (!credential || credential.status !== 'connected') return
    setBusy(true)
    setStatus(null)
    try {
      await publishCompute(credential)
      setStatus('Server compute is ready.')
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
      const activeRemoteRuns = serverRunManager.remembered().filter((run) => !['completed', 'completed_unplaced', 'failed', 'cancelled', 'interrupted'].includes(run.status)).length
      await invoke('server_disconnect')
      setConnection(null)
      setCredential(null)
      setRevision(0)
      setComputeCredentialRef(null)
      setComputeRevision(0)
      setOutlineCopied(false)
      setVerified(false)
      setStep('connect')
      setMode('local')
      setStatus(activeRemoteRuns
        ? `Local compute will be used after restart. ${activeRemoteRuns} server run${activeRemoteRuns === 1 ? '' : 's'} will continue and reconcile when you reconnect.`
        : 'Local compute will be used after restart. The server identity is remembered without retaining its access token.')
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  const stepIndex = WIZARD_STEPS.findIndex((entry) => entry.id === step)
  const setupComplete = Boolean(connection)
    && revision > 0

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

      {mode === 'server' && configurationConflict && (
        <div role="alert" className="settings-conflict">
          <strong>Agent configuration changed in both places</strong>
          <p className="settings-hint">Choose which complete configuration to keep. Closing Settings changes neither side.</p>
          <div className="settings-actions">
            <Button variant="primary" disabled={busy} onClick={() => void resolveConfigurationConflict('local')}>Use local</Button>
            <Button disabled={busy} onClick={() => void resolveConfigurationConflict('server')}>Use server</Button>
          </div>
        </div>
      )}

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
      ) : setupComplete && !wizardActive ? (
        <>
          <p className="settings-hint">Runs continue on {connection?.origin} while this app is closed. Server mode never falls back to local execution.</p>
          <code>{connection?.outlineId}</code>
          <p className="settings-hint">Credential: {credential?.status ?? 'not enrolled'} · Configuration revision: {revision}</p>
          {readiness && (
            <ul className="readiness-list" aria-label="Server readiness">
              {Object.entries({
                Connection: readiness.connection,
                'Outline sync': readiness.outlineSync,
                Configuration: readiness.agentConfiguration,
                Compute: readiness.computeProfile,
                Worker: readiness.worker,
                'Search index': readiness.noteIndex,
              }).map(([label, component]) => (
                <li key={label} className={component.ready ? 'is-ready' : 'is-not-ready'}>
                  <strong>{label}</strong>: {component.ready ? 'Ready' : component.message ?? 'Needs attention'}
                  {component.revision !== undefined ? ` · revision ${component.revision}` : ''}
                </li>
              ))}
            </ul>
          )}
          <div className="settings-actions">
            <Button variant="primary" disabled={busy} onClick={() => void testConnection()}>Test connection</Button>
            {credential?.status !== 'connected' && (
              <Button disabled={busy} onClick={() => { setWizardActive(true); setStep('credential') }}>Configure server compute</Button>
            )}
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
              <Field label="Server URL" htmlFor="forage-server-origin">
                <Input id="forage-server-origin" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://notes.example.com" />
              </Field>
              <Field label="Device token" htmlFor="forage-device-token">
                <Input id="forage-device-token" type="password" value={deviceToken} onChange={(event) => setDeviceToken(event.target.value)} autoComplete="off" />
              </Field>
            </>
          )}

          {step === 'copy' && (
            <>
              {alreadySeeded ? (
                <>
                  <p className="settings-hint">
                    This server already holds an outline. Connecting will switch this device to it and
                    leave this device's local outline behind.
                  </p>
                  <Button variant="primary" disabled={busy} onClick={() => void useServerOutline()}>
                    Use the server outline
                  </Button>
                </>
              ) : (
                <>
                  <p className="settings-hint">This device's outline, shortcuts, agents, skills, and tool settings become the server's content. Images upload first.</p>
                  <Button variant="primary" disabled={busy} onClick={() => void copyOutline()}>
                    {outlineCopied ? 'Finish syncing setup' : 'Copy everything to server'}
                  </Button>
                </>
              )}
            </>
          )}

          {step === 'verify' && (
            <>
              <p className="settings-hint">Check that {connection?.origin} answers with the pinned certificate and accepts this device token.</p>
              <Button variant="primary" disabled={busy} onClick={() => void verifyServer()}>
                {verified ? 'Test again' : 'Test connection'}
              </Button>
            </>
          )}

          {step === 'credential' && (
            <>
              <p className="settings-hint">The server needs its own OpenAI credential. It is stored server-side and never sent back to this device.</p>
              <Field label="Server OpenAI API key" htmlFor="server-openai-key">
                <Input id="server-openai-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" autoComplete="off" />
              </Field>
              <div className="settings-actions">
                <Button variant="primary" disabled={busy || apiKey.trim().length < 20} onClick={() => void enrollApiKey()}>Enroll API key</Button>
                <Button disabled={busy} onClick={() => void connectChatGpt()}>Connect ChatGPT</Button>
                <Button disabled={busy} onClick={() => void checkChatGpt()}>Check ChatGPT login</Button>
              </div>
              <p className="settings-hint">Credential: {credential?.status ?? 'not enrolled'}</p>
              {credential?.status === 'connected' && computeCredentialRef !== credential.id && (
                <Button variant="primary" disabled={busy} onClick={() => void retryAgentSettingsSync()}>
                  Retry syncing agent settings
                </Button>
              )}
            </>
          )}

          <div className="settings-actions compute-wizard-actions">
            {stepIndex > 0 && (
              <Button
                disabled={busy}
                onClick={() => setStep(WIZARD_STEPS[stepIndex - 1]!.id)}
              >
                Back
              </Button>
            )}
            {step === 'connect' && (
              <Button
                variant="primary"
                disabled={busy || !isLoaded || !origin.trim() || !deviceToken.trim()}
                onClick={() => void enrollServer()}
              >
                Connect server
              </Button>
            )}
            {step === 'verify' && (
              <Button variant="primary" disabled={busy || !verified} onClick={() => setStep('credential')}>Next</Button>
            )}
            {step === 'credential' && (
              <Button disabled={busy} onClick={() => void skipServerCompute()}>Skip server compute</Button>
            )}
            <Button disabled={busy} onClick={cancelWizard}>Cancel</Button>
          </div>
        </div>
      )}

      {status && <p role="status" className="settings-hint">{status}</p>}
    </div>
  )
}
