import { useEffect, useMemo, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Plus } from 'lucide-react'
import { AgentSettings } from './AgentSettings'
import { ConfirmButton } from './ConfirmButton'
import { PiRuntimeSettings } from './PiRuntimeSettings'
import {
  codexModelOptions,
  defaultCodexModel,
} from '../../agent/client'
import {
  loginWithChatGpt,
  type DeviceLoginInfo,
} from '../../agent/codexAuth'
import {
  APPROVED_TOOL_ORIGINS,
  BUILTIN_TOOL_OPTIONS,
} from '../../agent/tools'
import {
  useSettingsStore,
  type CodexAuthMode,
} from '../../store/settingsStore'
import { SecondaryViewHeader } from '../SecondaryViewHeader'
import { ComputeSettings } from './ComputeSettings'
import { ServerAgentSettings } from './ServerAgentSettings'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { SegmentedControl } from '../ui/SegmentedControl'
import { SwitchFieldInput } from '../ui/SwitchFieldInput'
import { ExtensionsSettings } from './ExtensionsSettings'
import {
  extensionAttentionCount,
  extensionExecutorOptions,
  extensionToolOptions,
  useExtensionStore,
} from '../../store/extensionStore'
import { Button } from '../ui/Button'
import { CountBadge } from '../ui/CountBadge'
import { ListRow } from '../ui/ListRow'
import { Field, Input, Select } from '../ui/Field'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type SettingsView = 'connection' | 'agents' | 'extensions' | 'advanced'

const SETTINGS_VIEWS: Array<{ id: SettingsView; label: string }> = [
  { id: 'connection', label: 'Connection' },
  { id: 'agents', label: 'Agents' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'advanced', label: 'Advanced' },
]

export function SettingsPanel({ onBack }: { onBack: () => void }) {
  const authMode = useSettingsStore((state) => state.authMode)
  const localCredentials = useSettingsStore((state) => state.localCredentials)
  const oauthCredential = localCredentials.find((credential) => credential.provider === 'openai-codex' && credential.status === 'connected')
  const apiKeyConfigured = localCredentials.some((credential) => credential.provider === 'openai' && credential.status === 'connected')
  const modelId = useSettingsStore((state) => state.modelId)
  const enabledToolIds = useSettingsStore((state) => state.enabledToolIds)
  const customTools = useSettingsStore((state) => state.customTools)
  const isLoaded = useSettingsStore((state) => state.isLoaded)
  const storeError = useSettingsStore((state) => state.error)
  const loadSettings = useSettingsStore((state) => state.load)
  const setAuthMode = useSettingsStore((state) => state.setAuthMode)
  const setOpenAiApiKey = useSettingsStore((state) => state.setOpenAiApiKey)
  const setOAuthCredential = useSettingsStore((state) => state.setOAuthCredential)
  const setModelId = useSettingsStore((state) => state.setModelId)
  const setToolEnabled = useSettingsStore((state) => state.setToolEnabled)
  const addCustomTool = useSettingsStore((state) => state.addCustomTool)
  const removeCustomTool = useSettingsStore((state) => state.removeCustomTool)
  const extensionCatalog = useExtensionStore((state) => state.catalog)

  const [activeView, setActiveView] = useState<SettingsView>('connection')
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [deviceInfo, setDeviceInfo] = useState<DeviceLoginInfo | null>(null)
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showToolForm, setShowToolForm] = useState(false)
  const [toolName, setToolName] = useState('')
  const [toolDescription, setToolDescription] = useState('')
  const [toolOrigin, setToolOrigin] = useState<string>(APPROVED_TOOL_ORIGINS[0].origin)
  const [toolPath, setToolPath] = useState<string>(APPROVED_TOOL_ORIGINS[0].examplePath)
  const loginController = useRef<AbortController | null>(null)
  const modelOptions = useMemo(() => codexModelOptions(authMode), [authMode])
  const extensionTools = useMemo(() => extensionToolOptions(extensionCatalog), [extensionCatalog])
  const extensionExecutors = useMemo(() => extensionExecutorOptions(extensionCatalog), [extensionCatalog])
  const extensionToolGroups = useMemo(() => {
    const groups = new Map<string, typeof extensionTools>()
    for (const tool of extensionTools) groups.set(tool.sourceName, [...(groups.get(tool.sourceName) ?? []), tool])
    return [...groups.entries()]
  }, [extensionTools])
  const attentionCount = extensionAttentionCount(extensionCatalog)
  const knownToolIds = new Set([
    ...BUILTIN_TOOL_OPTIONS.map((tool) => tool.id),
    ...customTools.map((tool) => tool.id),
    ...extensionTools.map((tool) => tool.id),
  ])
  const unavailableEnabledToolIds = enabledToolIds.filter((toolId) => !knownToolIds.has(toolId))

  useEffect(() => {
    if (!isLoaded) void loadSettings()
  }, [isLoaded, loadSettings])

  useEffect(() => setDraft(''), [apiKeyConfigured])
  useEffect(() => () => loginController.current?.abort(), [])

  async function chooseMode(mode: CodexAuthMode) {
    setActionError(null)
    try {
      await setAuthMode(mode)
      const options = codexModelOptions(mode)
      if (!options.some((option) => option.id === modelId)) {
        await setModelId(defaultCodexModel(mode))
      }
    } catch (error) {
      setActionError(describeError(error))
    }
  }

  async function saveApiKey() {
    setActionError(null)
    try {
      await setOpenAiApiKey(draft.trim())
      setDraft('')
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch (error) {
      setActionError(describeError(error))
    }
  }

  async function connectSubscription() {
    loginController.current?.abort()
    const controller = new AbortController()
    loginController.current = controller
    setLoginBusy(true)
    setDeviceInfo(null)
    setDeviceCodeCopied(false)
    setActionError(null)
    try {
      const credential = await loginWithChatGpt(setDeviceInfo, controller.signal)
      await setOAuthCredential(credential)
      setDeviceInfo(null)
    } catch (error) {
      if (!controller.signal.aborted) setActionError(describeError(error))
    } finally {
      if (loginController.current === controller) loginController.current = null
      setLoginBusy(false)
    }
  }

  function cancelSubscriptionLogin() {
    loginController.current?.abort()
    setDeviceInfo(null)
    setDeviceCodeCopied(false)
  }

  async function copyDeviceCode() {
    if (!deviceInfo) return
    setActionError(null)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.')
      await navigator.clipboard.writeText(deviceInfo.userCode)
      setDeviceCodeCopied(true)
    } catch (error) {
      setActionError(describeError(error))
    }
  }

  async function reopenLoginPage() {
    if (!deviceInfo) return
    setActionError(null)
    try {
      await openUrl(deviceInfo.verificationUri)
    } catch (error) {
      setActionError(describeError(error))
    }
  }

  async function disconnectSubscription() {
    setActionError(null)
    try {
      await setOAuthCredential(null)
    } catch (error) {
      setActionError(describeError(error))
    }
  }

  async function chooseModel(nextModelId: string) {
    setActionError(null)
    try {
      await setModelId(nextModelId)
    } catch (error) {
      setActionError(describeError(error))
    }
  }

  async function publishToolChange() {
    try {
      await publishLocalAgentConfiguration()
    } catch (error) {
      setActionError(`Saved on this device, but not published to the server: ${describeError(error)}`)
    }
  }

  async function toggleTool(toolId: string, enabled: boolean) {
    setActionError(null)
    try {
      await setToolEnabled(toolId, enabled)
    } catch (error) {
      setActionError(describeError(error))
      return
    }
    await publishToolChange()
  }

  async function createCustomTool() {
    setActionError(null)
    try {
      const path = toolPath.startsWith('/') ? toolPath : `/${toolPath}`
      await addCustomTool({
        name: toolName,
        description: toolDescription,
        urlTemplate: `${toolOrigin}${path}`,
      })
      setToolName('')
      setToolDescription('')
      setShowToolForm(false)
    } catch (error) {
      setActionError(describeError(error))
      return
    }
    await publishToolChange()
  }

  async function deleteCustomTool(toolId: string) {
    setActionError(null)
    try {
      await removeCustomTool(toolId)
    } catch (error) {
      setActionError(describeError(error))
      return
    }
    await publishToolChange()
  }

  return (
    <div className="secondary-view t-panel-slide" data-open="true">
      <SecondaryViewHeader onBack={onBack} />
      <div className="settings-panel settings-layout">
        <nav className="settings-sidebar" aria-label="Settings sections">
          <h1 className="secondary-page-title">Settings</h1>
          <div className="settings-nav-list">
            {SETTINGS_VIEWS.map((settingsView) => (
              <button
                key={settingsView.id}
                type="button"
                className={activeView === settingsView.id ? 'is-active' : undefined}
                aria-current={activeView === settingsView.id ? 'page' : undefined}
                onClick={() => {
                  setActionError(null)
                  setActiveView(settingsView.id)
                }}
              >
                <span>{settingsView.label}</span>
                {settingsView.id === 'extensions' && attentionCount > 0 && (
                  <CountBadge tone="attention" className="ml-auto" aria-label={`${attentionCount} need attention`}>{attentionCount}</CountBadge>
                )}
              </button>
            ))}
          </div>
        </nav>
        <div className="settings-content">

        <section hidden={activeView !== 'connection'} className="settings-section" aria-labelledby="connection-heading">
        <h2 id="connection-heading">Compute</h2>
        <ComputeSettings />
        <h2>Codex</h2>
        <SegmentedControl
          ariaLabel="Codex authentication method"
          className="mb-4"
          value={authMode}
          options={[
            { value: 'subscription', label: 'ChatGPT subscription' },
            { value: 'api_key', label: 'OpenAI API key' },
          ]}
          onValueChange={(mode) => void chooseMode(mode)}
        />

        {authMode === 'subscription' ? (
          <div className="auth-card">
            <strong>{oauthCredential ? 'Connected to ChatGPT' : 'Connect ChatGPT Plus or Pro'}</strong>
            <p className="settings-hint">
              Uses OpenAI Codex through your ChatGPT subscription, with the same device-code OAuth flow as Pi.
              Image generation uses Codex’s built-in GPT Image 2 capability and counts against your included Codex limits.
            </p>
            {deviceInfo && (
              <div className="device-login" aria-live="polite">
                <ol>
                  <li>Open the OpenAI sign-in page.</li>
                  <li>Enter this one-time code:</li>
                </ol>
                <div className="device-code">
                  <code>{deviceInfo.userCode}</code>
                  <button type="button" onClick={() => void copyDeviceCode()}>
                    {deviceCodeCopied ? 'Copied' : 'Copy code'}
                  </button>
                </div>
                <div className="device-login-actions">
                  <button type="button" onClick={() => void reopenLoginPage()}>Open browser again</button>
                  <Button variant="danger" onClick={cancelSubscriptionLogin}>Cancel</Button>
                </div>
              </div>
            )}
            <div className="settings-actions">
              <Button variant="primary"
                onClick={() => void connectSubscription()}
                disabled={!isLoaded || loginBusy}
              >
                {loginBusy ? 'Waiting for OpenAI…' : oauthCredential ? 'Reconnect' : 'Connect ChatGPT'}
              </Button>
              {oauthCredential && (
                <Button onClick={() => void disconnectSubscription()}>
                  Disconnect
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="auth-card">
            <Field label="OpenAI API key" htmlFor="openai-key">
              <Input
                id="openai-key"
                mono
                type="password"
                placeholder={apiKeyConfigured ? 'API key stored securely — enter a new key to replace it' : 'sk-...'}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <p className="settings-hint">
              Stored locally on this device and sent only to the OpenAI API. API usage is billed separately from ChatGPT.
            </p>
            <Button variant="primary" onClick={() => void saveApiKey()} disabled={!isLoaded}>
              {saved ? 'Saved ✓' : 'Save API key'}
            </Button>
          </div>
        )}

        <div className="model-setting">
          <div className="model-setting-copy">
            <label htmlFor="codex-model">Default model</label>
            <p id="codex-model-hint" className="settings-hint">
              Used unless an agent selects a different model.
            </p>
          </div>
          <div className="model-select">
            <Select
              id="codex-model"
              aria-describedby="codex-model-hint"
              value={modelOptions.some((option) => option.id === modelId) ? modelId : defaultCodexModel(authMode)}
              onChange={(event) => void chooseModel(event.target.value)}
              disabled={!isLoaded}
            >
              {modelOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </Select>
          </div>
        </div>
      </section>

      <div hidden={activeView !== 'agents'} className="settings-view" aria-label="Agent settings">
        <AgentSettings extensionTools={extensionTools} extensionExecutors={extensionExecutors} reportError={(error) => setActionError(describeError(error))} />
      </div>

      <section hidden={activeView !== 'agents'} className="settings-section settings-tools-section" aria-labelledby="tools-heading">
        <h2 id="tools-heading">Tools</h2>
        <p className="settings-hint">
          Globally enabled tools may be called through Pi only when the selected agent also allows them. Image generation is opt-in; subscription mode uses Codex limits and API-key mode uses API billing.
        </p>
        <h3>Built-in</h3>
        <div className="overflow-hidden rounded-[10px] border border-rule-soft bg-paper-raised">
          {BUILTIN_TOOL_OPTIONS.map((tool) => (
            <SwitchFieldInput
              key={tool.id}
             
              label={tool.name}
              hint={tool.description}
              checked={enabledToolIds.includes(tool.id)}
              onCheckedChange={(checked) => void toggleTool(tool.id, checked)}
              disabled={!isLoaded}
            />
          ))}
        </div>
        {customTools.length > 0 && <><h3>Custom HTTP</h3><div className="overflow-hidden rounded-[10px] border border-rule-soft bg-paper-raised">
          {customTools.map((tool) => (
            <SwitchFieldInput
              key={tool.id}
             
              label={tool.name}
              hint={(
                <>
                  <span className="block">{tool.description}</span>
                  <code className="mt-1 block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-neutral-400">{tool.urlTemplate}</code>
                </>
              )}
              checked={enabledToolIds.includes(tool.id)}
              onCheckedChange={(checked) => void toggleTool(tool.id, checked)}
              switchAriaLabel={`Enable ${tool.name}`}
              disabled={!isLoaded}
              actions={(
                <ConfirmButton
                  label="Remove"
                  confirmLabel="Confirm remove"
                  variant="danger"
                  size="sm"
                  ariaLabel={`Remove ${tool.name}`}
                  confirmAriaLabel={`Confirm removing ${tool.name}`}
                  onConfirm={() => void deleteCustomTool(tool.id)}
                />
              )}
            />
          ))}
        </div></>}
        {extensionToolGroups.length > 0 && <><h3>Extensions</h3>{extensionToolGroups.map(([sourceName, tools]) => <div key={sourceName} className="extension-tool-group"><h4>{sourceName}</h4><div className="overflow-hidden rounded-[10px] border border-rule-soft bg-paper-raised">
          {tools.map((tool) => <SwitchFieldInput key={`${tool.installationId}:${tool.id}`} label={tool.name} hint={tool.available ? tool.description : `${tool.description} Unavailable: ${tool.unavailableReason}`} checked={enabledToolIds.includes(tool.id)} onCheckedChange={(checked) => void toggleTool(tool.id, checked)} switchAriaLabel={`Enable ${tool.name}`} disabled={!isLoaded || !tool.available} />)}
        </div></div>)}</>}
        {unavailableEnabledToolIds.length > 0 && <><h3>Unavailable references</h3><div className="tool-list">
          {unavailableEnabledToolIds.map((toolId) => <ListRow key={toolId} title={toolId} description="The configured provider is missing or unavailable. This reference is retained." actions={<Button size="sm" onClick={() => void toggleTool(toolId, false)}>Disable reference</Button>} />)}
        </div></>}

        {showToolForm ? (
          <div className="custom-tool-form">
            <strong>Add public GET tool</strong>
            <Field label="Tool name" htmlFor="tool-name">
              <Input
                id="tool-name"
                mono
                value={toolName}
                onChange={(event) => setToolName(event.target.value)}
                placeholder="github_issues"
                spellCheck={false}
              />
            </Field>
            <Field label="Description for Codex" htmlFor="tool-description">
              <Input
                id="tool-description"
                value={toolDescription}
                onChange={(event) => setToolDescription(event.target.value)}
                placeholder="List public GitHub issues for a repository"
              />
            </Field>
            <Field label="Approved API" htmlFor="tool-origin">
              <Select
                id="tool-origin"
                value={toolOrigin}
                onChange={(event) => {
                  const selected = APPROVED_TOOL_ORIGINS.find((item) => item.origin === event.target.value)
                  setToolOrigin(event.target.value)
                  if (selected) setToolPath(selected.examplePath)
                }}
              >
                {APPROVED_TOOL_ORIGINS.map((item) => (
                  <option key={item.origin} value={item.origin}>{item.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Path and query template" htmlFor="tool-path">
              <Input
                id="tool-path"
                mono
                value={toolPath}
                onChange={(event) => setToolPath(event.target.value)}
                placeholder="/repos/{{owner}}/{{repo}}/issues"
                spellCheck={false}
              />
            </Field>
            <p className="settings-hint">
              Each {'{{parameter}}'} becomes a required string argument available to Codex. Only public GET endpoints are supported.
            </p>
            <div className="settings-actions">
              <Button variant="primary" onClick={() => void createCustomTool()}>
                Add tool
              </Button>
              <Button onClick={() => setShowToolForm(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="add" icon={<Plus aria-hidden="true" />} className="self-start" onClick={() => setShowToolForm(true)}>
            Add custom tool
          </Button>
        )}

        <p className="settings-hint tool-privacy">
          Search queries go to DuckDuckGo. Page URLs go to Jina Reader. Images are generated by OpenAI GPT Image 2 and stored as bounded raster data inside the outline. Custom tools are limited to the approved public API origins above; after adding one, edit an agent to allow it.
        </p>
      </section>

      <div hidden={activeView !== 'agents'} className="settings-view">
        <ServerAgentSettings />
      </div>

        {activeView === 'extensions' && (
          <div className="settings-view">
            <ExtensionsSettings onConfigureTools={() => setActiveView('agents')} />
          </div>
        )}

        <div hidden={activeView !== 'advanced'} className="settings-view">
          <PiRuntimeSettings />
        </div>

        {(actionError || storeError) && (
          <p className="settings-error" role="alert">{actionError || storeError}</p>
        )}
        </div>
      </div>
    </div>
  )
}
