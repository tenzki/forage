import { useEffect, useMemo, useRef, useState } from 'react'
import {
  codexModelOptions,
  defaultCodexModel,
} from '../../agent/client'
import {
  loginWithChatGpt,
  type DeviceLoginInfo,
} from '../../agent/codexAuth'
import {
  useSettingsStore,
  type CodexAuthMode,
} from '../../store/settingsStore'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function SettingsPanel({ onBack }: { onBack: () => void }) {
  const authMode = useSettingsStore((state) => state.authMode)
  const openAiApiKey = useSettingsStore((state) => state.openAiApiKey)
  const oauthCredential = useSettingsStore((state) => state.oauthCredential)
  const modelId = useSettingsStore((state) => state.modelId)
  const isLoaded = useSettingsStore((state) => state.isLoaded)
  const storeError = useSettingsStore((state) => state.error)
  const loadSettings = useSettingsStore((state) => state.load)
  const setAuthMode = useSettingsStore((state) => state.setAuthMode)
  const setOpenAiApiKey = useSettingsStore((state) => state.setOpenAiApiKey)
  const setOAuthCredential = useSettingsStore((state) => state.setOAuthCredential)
  const setModelId = useSettingsStore((state) => state.setModelId)

  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [deviceInfo, setDeviceInfo] = useState<DeviceLoginInfo | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
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

  return (
    <div className="settings-panel">
      <header className="settings-header">
        <button className="settings-back" onClick={onBack}>← Back</button>
        <h1>Settings</h1>
      </header>

      <section className="settings-section">
        <h2>Codex</h2>
        <div className="auth-mode" role="group" aria-label="Codex authentication method">
          <button
            className={authMode === 'subscription' ? 'active' : ''}
            onClick={() => void chooseMode('subscription')}
          >
            ChatGPT subscription
          </button>
          <button
            className={authMode === 'api_key' ? 'active' : ''}
            onClick={() => void chooseMode('api_key')}
          >
            OpenAI API key
          </button>
        </div>

        {authMode === 'subscription' ? (
          <div className="auth-card">
            <strong>{oauthCredential ? 'Connected to ChatGPT' : 'Connect ChatGPT Plus or Pro'}</strong>
            <p className="settings-hint">
              Uses OpenAI Codex through your ChatGPT subscription, with the same device-code OAuth flow as pi.
            </p>
            {deviceInfo && (
              <div className="device-code" aria-live="polite">
                <span>Enter this code in the browser:</span>
                <code>{deviceInfo.userCode}</code>
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

        <label htmlFor="codex-model">Model</label>
        <select
          id="codex-model"
          value={modelOptions.some((option) => option.id === modelId) ? modelId : defaultCodexModel(authMode)}
          onChange={(event) => void chooseModel(event.target.value)}
          disabled={!isLoaded}
        >
          {modelOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>

        {(actionError || storeError) && (
          <p className="settings-error" role="alert">{actionError || storeError}</p>
        )}
      </section>
    </div>
  )
}
