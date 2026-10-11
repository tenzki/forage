import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Plus } from 'lucide-react'
import { MODEL_PROVIDERS, type ModelProvider, type ProviderCapability } from '@forage/agent-runtime'
import type { CredentialMetadata } from '@forage/protocol'
import { getProviderCapabilities } from '@forage/pi-runtime/provider-catalog'
import { TauriServerAgentTransport } from '../../agent/serverExecutor'
import { loginWithChatGpt, type DeviceLoginInfo } from '../../agent/codexAuth'
import { useSettingsStore } from '../../store/settingsStore'
import { Button } from '../ui/Button'
import { Field, Input, Select } from '../ui/Field'
import { ConfirmButton } from './ConfirmButton'
import { useSettingsNavigation } from './settingsNavigation'

const localCapabilities = getProviderCapabilities(MODEL_PROVIDERS.map((provider) => provider.id))
const transport = new TauriServerAgentTransport()
type Profile = Awaited<ReturnType<typeof transport.computeProfile>>['profile']
type Account = Pick<CredentialMetadata, 'id' | 'provider' | 'status' | 'accountLabel' | 'expiresAt'>

export function ProviderConnectionsSettings({ environmentRevision = 0 }: { environmentRevision?: number }) {
  const localAccounts = useSettingsStore((state) => state.localCredentials)
  const localCompute = useSettingsStore((state) => state.localCompute)
  const loaded = useSettingsStore((state) => state.isLoaded)
  const [mode, setMode] = useState<'local' | 'server' | null>(null)
  const [accounts, setAccounts] = useState<CredentialMetadata[]>([])
  const [capabilities, setCapabilities] = useState<ProviderCapability[] | undefined>()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [provider, setProvider] = useState<ModelProvider | ''>('')
  const [model, setModel] = useState('')
  const [form, setForm] = useState<ModelProvider | null>(null)
  const [managing, setManaging] = useState<Account | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [device, setDevice] = useState<DeviceLoginInfo | null>(null)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const environment = useRef(0)
  const navigation = useSettingsNavigation()

  async function refreshServer() {
    const revision = environment.current
    const readiness = await transport.readiness()
    if (!readiness.supportedProviders) {
      const current = await transport.computeProfile().then((value) => value.profile).catch(() => null)
      if (revision !== environment.current) return
      setCapabilities(undefined)
      setAccounts([])
      setProfile(current)
      return
    }
    const inventory = await transport.accounts()
    const current = await transport.computeProfile().then((value) => value.profile).catch((failure: unknown) => {
      if (String(failure).includes('compute_unavailable')) return null
      throw failure
    })
    if (revision !== environment.current) return
    setCapabilities(readiness.supportedProviders)
    setAccounts(inventory)
    setProfile(current)
  }

  useEffect(() => {
    controller.current?.abort()
    environment.current += 1
    setMode(null)
    setCapabilities(undefined)
    setAccounts([])
    setProfile(null)
    setForm(null)
    setManaging(null)
    setKey('')
    setProvider('')
    setModel('')
    setError(null)
    let active = true
    if (loaded) void invoke<'local' | 'server'>('event_store_storage_mode').then(async (value) => {
      if (!active) return
      if (value !== 'local' && value !== 'server') throw new Error('Compute environment is unavailable.')
      setMode(value)
      if (value === 'server') await refreshServer()
      else setCapabilities(localCapabilities)
    }).catch(() => { if (active) setError('Could not load this environment’s provider connections. Retry after restoring the connection.') })
    return () => { active = false; environment.current += 1; controller.current?.abort() }
  }, [loaded, environmentRevision, refreshRevision])

  const inventory = mode === 'local' ? localAccounts : accounts
  const selected = mode === 'local' ? localCompute : profile
  const supported = !!mode && !!capabilities
  const displayedProvider = provider || selected?.provider || ''
  const displayedModel = provider ? model : selected?.modelId ?? ''
  const availableModels = capabilities?.find((entry) => entry.provider === displayedProvider)?.modelIds ?? []
  const connectedProviders = MODEL_PROVIDERS.filter((entry) => capabilities?.some((capability) => capability.provider === entry.id) && inventory.some((account) => account.provider === entry.id && account.status === 'connected'))
  const defaultAccount = inventory.find((account) => account.id === selected?.credentialRef && account.provider === selected?.provider && account.status === 'connected')
  useEffect(() => {
    if (managing && supported && !inventory.some((account) => account.id === managing.id)) {
      cancel()
      navigation?.back()
      setError('This account is no longer available. Returned to Connection.')
    }
  }, [managing, supported, inventory, navigation])

  function cancel() {
    controller.current?.abort()
    setKey('')
    setForm(null)
    setManaging(null)
    setDevice(null)
    setError(null)
  }
  function closePage() {
    cancel()
    if (navigation?.route.page === 'provider') navigation.back()
  }

  async function connect() {
    if (!form || busy || !mode || !supported) return
    const operation = new AbortController()
    controller.current = operation
    setBusy(true)
    setError(null)
    try {
      if (form !== 'openai-codex') {
        if (mode === 'local') await useSettingsStore.getState().connectApiKey(form, key, operation.signal)
        else await transport.enrollApiKey({ provider: form, apiKey: key }, operation.signal)
      } else if (mode === 'local') {
        const credential = await loginWithChatGpt(setDevice, operation.signal)
        operation.signal.throwIfAborted()
        await useSettingsStore.getState().setOAuthCredential(credential)
      } else {
        const authorization = await transport.startDeviceAuthorization()
        try {
          operation.signal.throwIfAborted()
          setDevice({ userCode: authorization.userCode, verificationUri: authorization.verificationUri })
          await openUrl(authorization.verificationUri)
          for (;;) {
            operation.signal.throwIfAborted()
            if (Date.now() >= Date.parse(authorization.expiresAt)) throw new Error('Sign-in expired. Try again.')
            const status = await transport.pollDeviceAuthorization(authorization.authorizationId)
            if (status.state === 'connected') break
            if (status.state !== 'pending') throw new Error('Sign-in was not completed. Try again.')
            await new Promise<void>((resolve, reject) => {
              const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')) }
              const timer = setTimeout(() => { operation.signal.removeEventListener('abort', abort); resolve() }, authorization.pollIntervalSeconds * 1000)
              operation.signal.addEventListener('abort', abort, { once: true })
            })
          }
        } catch (failure) {
          await transport.disconnectCredential(authorization.authorizationId).catch(() => undefined)
          throw failure
        }
      }
      operation.signal.throwIfAborted()
      if (mode === 'server') await refreshServer()
      setKey('')
      setForm(null)
      setManaging(null)
      setDevice(null)
      if (navigation?.route.page === 'provider') navigation.back()
    } catch {
      setKey('')
      if (!operation.signal.aborted) setError('Could not connect this provider. Check the credential, account access, and connection, then try again.')
    } finally {
      if (controller.current === operation) controller.current = null
      setBusy(false)
    }
  }

  async function disconnect(account: Account) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'local') await useSettingsStore.getState().disconnectAccount(account.id)
      else if (mode === 'server') { await transport.disconnectCredential(account.id); await refreshServer() }
      closePage()
    } catch { setError('Could not disconnect this account. Try again.') }
    finally { setBusy(false) }
  }

  async function saveDefault() {
    const account = inventory.find((entry) => entry.id === selected?.credentialRef && entry.provider === provider && entry.status === 'connected')
      ?? inventory.find((entry) => entry.provider === provider && entry.status === 'connected')
    if (!account || !provider || !availableModels.includes(model) || busy) return
    setBusy(true)
    setError(null)
    try {
      const selection = { provider, modelId: model, credentialRef: account.id }
      if (mode === 'local') await useSettingsStore.getState().selectLocalCompute(selection)
      else if (mode === 'server') {
        const result = await transport.publishComputeProfile({ baseRevision: profile?.revision ?? 0, profile: { version: 1, revision: (profile?.revision ?? 0) + 1, ...selection } })
        setProfile(result.profile)
      }
      setProvider('')
      setModel('')
    } catch {
      setError('Default was not changed. Reloaded the current server revision; review your selection and retry.')
      if (mode === 'server') await refreshServer().catch(() => undefined)
    } finally { setBusy(false) }
  }

  return <div className={`settings-block provider-connections${form ? ' provider-setup' : ''}`} aria-label="Provider connections">
    <div className="settings-page-heading"><div className="settings-heading-copy"><h2>{form ? managing ? 'Reconnect provider' : 'Add provider' : managing ? 'Manage provider' : 'Providers'}</h2><p className="settings-hint">{form ? 'Choose a provider and connect your account.' : mode === 'server' ? 'Server accounts and compute. Device credentials are never transferred.' : mode === 'local' ? 'Your connected accounts. Add providers as you need them.' : 'Loading compute environment…'}</p></div>
      {!form && !managing && <Button className="shrink-0" disabled={!supported || busy} onClick={() => { setManaging(null); setForm(capabilities?.[0]?.provider ?? null); setError(null); navigation?.open('connection', 'provider', cancel) }} icon={<Plus size={14} aria-hidden="true" />}>Add provider</Button>}
    </div>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {error && !supported && <Button onClick={() => setRefreshRevision((revision) => revision + 1)}>Retry connection</Button>}
    {mode === 'server' && !capabilities && <p role="status">Provider management requires a newer server. Upgrade before changing provider or model.</p>}
    {!form && !managing && <div className={inventory.length ? 'settings-row-list' : undefined}>
      {inventory.map((account) => <div key={account.id} className="settings-inventory-row provider-account-row">
        <div className="settings-inventory-copy"><strong>{MODEL_PROVIDERS.find((entry) => entry.id === account.provider)?.label}</strong><p className="settings-hint">{account.status === 'connected' ? 'Connected' : 'Authentication required'} · {account.provider === 'openai-codex' ? 'ChatGPT subscription' : 'API key'}{selected?.credentialRef === account.id ? ' · Default' : ''}</p></div>
        <Button id={`manage-provider-${account.id}`} disabled={!supported || busy} onClick={() => { cancel(); setManaging(account); navigation?.open('connection', 'provider', cancel, account.id) }}>Manage</Button>
      </div>)}
      {inventory.length === 0 && supported && <p className="settings-hint">No providers connected.</p>}
    </div>}
    {managing && !form && <div className="settings-block" aria-label="Manage provider">
      <strong>Manage {MODEL_PROVIDERS.find((entry) => entry.id === managing.provider)?.label}</strong>
      <div className="settings-actions"><Button disabled={busy} onClick={() => setForm(managing.provider)}>Reconnect</Button><ConfirmButton label="Disconnect" confirmLabel="Confirm disconnect" disabled={busy} onConfirm={() => void disconnect(managing)} /><Button onClick={closePage}>Cancel</Button></div>
    </div>}
    {form ? <div className="settings-block provider-setup-form" aria-label="Add provider form">
      <Field label="Provider" htmlFor="connection-provider"><Select id="connection-provider" value={form} disabled={busy || !!managing} onChange={(event) => { setForm(event.target.value as ModelProvider); setKey(''); setError(null) }}>{MODEL_PROVIDERS.filter((entry) => capabilities?.some((capability) => capability.provider === entry.id)).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</Select></Field>
      <div className="settings-block settings-divider">
      <div className="settings-heading-copy"><h2>Connect {MODEL_PROVIDERS.find((entry) => entry.id === form)?.label}</h2><p className="settings-hint">{form === 'openai-codex' ? 'Sign in with your ChatGPT subscription.' : 'Enter the API key from your provider account.'}</p></div>
      {form !== 'openai-codex' && <Field label="API key" htmlFor="connection-key"><Input id="connection-key" type="password" value={key} disabled={busy} autoComplete="off" spellCheck={false} onChange={(event) => setKey(event.target.value)} /></Field>}
      {device && <div aria-live="polite"><code>{device.userCode}</code><div className="settings-actions"><Button onClick={() => void navigator.clipboard.writeText(device.userCode).catch(() => setError('Clipboard unavailable.'))}>Copy code</Button><Button onClick={() => void openUrl(device.verificationUri).catch(() => setError('Could not open sign-in page.'))}>Open sign-in page</Button></div></div>}
      <div className="settings-actions"><Button variant="primary" disabled={busy || (form !== 'openai-codex' && !key.trim())} onClick={() => void connect()}>{busy ? 'Connecting…' : form === 'openai-codex' ? 'Connect ChatGPT' : 'Connect provider'}</Button><Button onClick={closePage}>Cancel</Button></div>
      <p className="settings-hint settings-footnote">Once connected, this provider’s models appear in the default model selector.</p>
      </div>
    </div> : null}
    {!form && !managing && <section className="settings-block provider-defaults" aria-label="Default compute">
    <h3 id="default-compute-heading">Default model</h3>
    <p className="settings-hint">Current: {selected ? `${MODEL_PROVIDERS.find((entry) => entry.id === selected.provider)?.label} / ${selected.modelId}` : 'Not configured'}. Agents inherit this compute selection.</p>
    {selected && !defaultAccount && supported && <p role="status">The default account is unavailable. Reconnect it or explicitly choose another provider and model.</p>}
    <div className="settings-fields-row"><Field label="Default provider" htmlFor="default-provider"><Select id="default-provider" disabled={!supported || busy} value={displayedProvider} onChange={(event) => { setProvider(event.target.value as ModelProvider); setModel('') }}><option value="">Choose provider</option>{displayedProvider && !connectedProviders.some((entry) => entry.id === displayedProvider) && <option value={displayedProvider} disabled>{MODEL_PROVIDERS.find((entry) => entry.id === displayedProvider)?.label} (unavailable)</option>}{connectedProviders.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</Select></Field>
    <Field label="Default model" htmlFor="default-model"><Select id="default-model" disabled={!supported || !connectedProviders.some((entry) => entry.id === displayedProvider) || busy} value={displayedModel} onChange={(event) => { if (!provider && selected) setProvider(selected.provider); setModel(event.target.value) }}><option value="">Choose model</option>{displayedModel && !availableModels.includes(displayedModel) && <option value={displayedModel} disabled>{displayedModel} (unavailable)</option>}{availableModels.map((id) => <option key={id} value={id}>{id}</option>)}</Select></Field>
    </div><p className="settings-hint">Only connected providers are available here.</p>
    <Button className="self-start" variant="primary" disabled={!supported || !connectedProviders.some((entry) => entry.id === provider) || !availableModels.includes(model) || busy} onClick={() => void saveDefault()}>Save defaults</Button>
    </section>}
  </div>
}
