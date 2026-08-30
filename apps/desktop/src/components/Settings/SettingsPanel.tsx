import { useEffect, useMemo, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ChevronDown } from 'lucide-react'
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
import { StorageBackendSettings } from './StorageBackendSettings'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type SettingsView = 'connection' | 'agents' | 'advanced'

const SETTINGS_VIEWS: Array<{ id: SettingsView; label: string }> = [
  { id: 'connection', label: 'Connection' },
  { id: 'agents', label: 'Agents' },
  { id: 'advanced', label: 'Advanced' },
]

export function SettingsPanel({ onBack }: { onBack: () => void }) {
  const authMode = useSettingsStore((state) => state.authMode)
  const openAiApiKey = useSettingsStore((state) => state.openAiApiKey)
  const oauthCredential = useSettingsStore((state) => state.oauthCredential)
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

  useEffect(() => {
    if (!isLoaded) void loadSettings()
  }, [isLoaded, loadSettings])

  useEffect(() => setDraft(openAiApiKey), [openAiApiKey])
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

  async function toggleTool(toolId: string, enabled: boolean) {
    setActionError(null)
    try {
      await setToolEnabled(toolId, enabled)
    } catch (error) {
      setActionError(describeError(error))
    }
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
    }
  }

  async function deleteCustomTool(toolId: string) {
    setActionError(null)
    try {
      await removeCustomTool(toolId)
    } catch (error) {
      setActionError(describeError(error))
    }
  }

  return (
    <div className="secondary-view">
      <SecondaryViewHeader title="Settings" onBack={onBack} />
      <div className="settings-panel">
        <nav className="settings-navigation" aria-label="Settings sections">
          {SETTINGS_VIEWS.map((settingsView) => (
            <button
              key={settingsView.id}
              type="button"
              className={activeView === settingsView.id ? 'active' : ''}
              aria-current={activeView === settingsView.id ? 'page' : undefined}
              onClick={() => {
                setActionError(null)
                setActiveView(settingsView.id)
              }}
            >
              {settingsView.label}
            </button>
          ))}
        </nav>

        <section hidden={activeView !== 'connection'} className="settings-section" aria-labelledby="connection-heading">
        <h2 id="connection-heading">Storage</h2>
        <StorageBackendSettings />
        <h2>Codex</h2>
        <div className="auth-mode" role="group" aria-label="Codex authentication method">
          <button
            type="button"
            className={authMode === 'subscription' ? 'active' : ''}
            aria-pressed={authMode === 'subscription'}
            onClick={() => void chooseMode('subscription')}
          >
            ChatGPT subscription
          </button>
          <button
            type="button"
            className={authMode === 'api_key' ? 'active' : ''}
            aria-pressed={authMode === 'api_key'}
            onClick={() => void chooseMode('api_key')}
          >
            OpenAI API key
          </button>
        </div>

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
                  <button type="button" className="danger-action" onClick={cancelSubscriptionLogin}>Cancel</button>
                </div>
              </div>
            )}
            <div className="settings-actions">
              <button
                className="settings-save"
                onClick={() => void connectSubscription()}
                disabled={!isLoaded || loginBusy}
              >
                {loginBusy ? 'Waiting for OpenAI…' : oauthCredential ? 'Reconnect' : 'Connect ChatGPT'}
              </button>
              {oauthCredential && (
                <button className="settings-secondary" onClick={() => void disconnectSubscription()}>
                  Disconnect
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="auth-card">
            <label htmlFor="openai-key">OpenAI API key</label>
            <input
              id="openai-key"
              className="settings-monospace"
              type="password"
              placeholder="sk-..."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="settings-hint">
              Stored locally on this device and sent only to the OpenAI API. API usage is billed separately from ChatGPT.
            </p>
            <button className="settings-save" onClick={() => void saveApiKey()} disabled={!isLoaded}>
              {saved ? 'Saved ✓' : 'Save API key'}
            </button>
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
            <select
              id="codex-model"
              aria-describedby="codex-model-hint"
              value={modelOptions.some((option) => option.id === modelId) ? modelId : defaultCodexModel(authMode)}
              onChange={(event) => void chooseModel(event.target.value)}
              disabled={!isLoaded}
            >
              {modelOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
          </div>
        </div>
      </section>

      <div hidden={activeView !== 'agents'} className="settings-view" aria-label="Agent settings">
        <AgentSettings reportError={(error) => setActionError(describeError(error))} />
      </div>

      <section hidden={activeView !== 'agents'} className="settings-section settings-tools-section" aria-labelledby="tools-heading">
        <h2 id="tools-heading">Tools</h2>
        <p className="settings-hint">
          Globally enabled tools may be called through Pi only when the selected agent also allows them. Image generation is opt-in; subscription mode uses Codex limits and API-key mode uses API billing.
        </p>
        <div className="tool-list">
          {BUILTIN_TOOL_OPTIONS.map((tool) => (
            <label className="tool-setting" key={tool.id}>
              <span>
                <strong>{tool.name}</strong>
                <small>{tool.description}</small>
              </span>
              <input
                type="checkbox"
                checked={enabledToolIds.includes(tool.id)}
                onChange={(event) => void toggleTool(tool.id, event.target.checked)}
                disabled={!isLoaded}
              />
            </label>
          ))}
          {customTools.map((tool) => (
            <div className="tool-setting" key={tool.id}>
              <span>
                <strong>{tool.name}</strong>
                <small>{tool.description}</small>
                <code>{tool.urlTemplate}</code>
              </span>
              <div className="tool-setting-actions">
                <input
                  type="checkbox"
                  aria-label={`Enable ${tool.name}`}
                  checked={enabledToolIds.includes(tool.id)}
                  onChange={(event) => void toggleTool(tool.id, event.target.checked)}
                  disabled={!isLoaded}
                />
                <ConfirmButton
                  label="Remove"
                  confirmLabel="Confirm remove"
                  className="tool-remove"
                  ariaLabel={`Remove ${tool.name}`}
                  confirmAriaLabel={`Confirm removing ${tool.name}`}
                  onConfirm={() => void deleteCustomTool(tool.id)}
                />
              </div>
            </div>
          ))}
        </div>

        {showToolForm ? (
          <div className="custom-tool-form">
            <strong>Add public GET tool</strong>
            <label htmlFor="tool-name">Tool name</label>
            <input
              id="tool-name"
              className="settings-monospace"
              value={toolName}
              onChange={(event) => setToolName(event.target.value)}
              placeholder="github_issues"
              spellCheck={false}
            />
            <label htmlFor="tool-description">Description for Codex</label>
            <input
              id="tool-description"
              value={toolDescription}
              onChange={(event) => setToolDescription(event.target.value)}
              placeholder="List public GitHub issues for a repository"
            />
            <label htmlFor="tool-origin">Approved API</label>
            <select
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
            </select>
            <label htmlFor="tool-path">Path and query template</label>
            <input
              id="tool-path"
              className="settings-monospace"
              value={toolPath}
              onChange={(event) => setToolPath(event.target.value)}
              placeholder="/repos/{{owner}}/{{repo}}/issues"
              spellCheck={false}
            />
            <p className="settings-hint">
              Each {'{{parameter}}'} becomes a required string argument available to Codex. Only public GET endpoints are supported.
            </p>
            <div className="settings-actions">
              <button className="settings-save" onClick={() => void createCustomTool()}>
                Add tool
              </button>
              <button className="settings-secondary" onClick={() => setShowToolForm(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="settings-secondary add-tool" onClick={() => setShowToolForm(true)}>
            + Add custom tool
          </button>
        )}

        <p className="settings-hint tool-privacy">
          Search queries go to DuckDuckGo. Page URLs go to Jina Reader. Images are generated by OpenAI GPT Image 2 and stored as bounded raster data inside the outline. Custom tools are limited to the approved public API origins above; after adding one, edit an agent to allow it.
        </p>
      </section>

        <div hidden={activeView !== 'advanced'} className="settings-view">
          <PiRuntimeSettings />
        </div>

        {(actionError || storeError) && (
          <p className="settings-error" role="alert">{actionError || storeError}</p>
        )}
      </div>
    </div>
  )
}
