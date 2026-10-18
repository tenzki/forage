import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { AgentSettings } from './AgentSettings'
import { ConfirmButton } from './ConfirmButton'
import { GeneralSettings } from './GeneralSettings'
import { DiagnosticsSettings } from './DiagnosticsSettings'
import { SettingsBackLink } from './SettingsBackLink'
import { SettingsNavigationProvider, settingsSections, useSettingsRouter } from './settingsNavigation'
import {
  APPROVED_TOOL_ORIGINS,
  BUILTIN_TOOL_OPTIONS,
} from '../../agent/tools'
import { useSettingsStore } from '../../store/settingsStore'
import { SecondaryViewHeader } from '../SecondaryViewHeader'
import { ComputeSettings } from './ComputeSettings'
import { ServerAgentSettings } from './ServerAgentSettings'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { ProviderConnectionsSettings } from './ProviderConnectionsSettings'
import { SwitchFieldInput } from '../ui/SwitchFieldInput'
import { ExtensionsSettings } from './ExtensionsSettings'
import { McpSettings } from './McpSettings'
import {
  extensionAttentionCount,
  extensionExecutorOptions,
  extensionToolOptions,
  useExtensionStore,
} from '../../store/extensionStore'
import { Button } from '../ui/Button'
import { CountBadge } from '../ui/CountBadge'
import { Field, Input, Select } from '../ui/Field'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function SettingsPanel({ onBack, registerExit, onboarding }: { onBack: () => void; registerExit?: (exit: ((action?: () => void) => void) | null) => void; onboarding?: { available: boolean; onStart: () => void } }) {
  const enabledToolIds = useSettingsStore((state) => state.enabledToolIds)
  const customTools = useSettingsStore((state) => state.customTools)
  const isLoaded = useSettingsStore((state) => state.isLoaded)
  const storeError = useSettingsStore((state) => state.error)
  const loadSettings = useSettingsStore((state) => state.load)
  const setToolEnabled = useSettingsStore((state) => state.setToolEnabled)
  const addCustomTool = useSettingsStore((state) => state.addCustomTool)
  const removeCustomTool = useSettingsStore((state) => state.removeCustomTool)
  const extensionCatalog = useExtensionStore((state) => state.catalog)

  const navigation = useSettingsRouter()
  useEffect(() => {
    registerExit?.((action) => navigation.requestLeave(action ?? onBack))
    return () => registerExit?.(null)
  }, [navigation, onBack, registerExit])
  const activeView = navigation.route.section
  const setActiveView = navigation.select
  const [environmentRevision, setEnvironmentRevision] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showToolForm, setShowToolForm] = useState(false)
  const [toolName, setToolName] = useState('')
  const [toolDescription, setToolDescription] = useState('')
  const [toolOrigin, setToolOrigin] = useState<string>(APPROVED_TOOL_ORIGINS[0].origin)
  const [toolPath, setToolPath] = useState<string>(APPROVED_TOOL_ORIGINS[0].examplePath)
  const extensionTools = useMemo(() => extensionToolOptions(extensionCatalog), [extensionCatalog])
  const extensionExecutors = useMemo(() => extensionExecutorOptions(extensionCatalog), [extensionCatalog])
  const attentionCount = extensionAttentionCount(extensionCatalog)

  useEffect(() => {
    if (!isLoaded) void loadSettings()
  }, [isLoaded, loadSettings])

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
    <SettingsNavigationProvider value={navigation}>
    <div className="secondary-view settings-screen t-panel-slide" data-open="true">
      <SecondaryViewHeader onBack={() => navigation.requestLeave(onBack)} />
      <div className="settings-panel settings-layout">
        <nav className="settings-sidebar" aria-label="Settings sections">
          <h1 className="secondary-page-title">Settings</h1>
          <div className="settings-nav-list">
            {settingsSections.map((settingsView) => (
              <button
                key={settingsView.id}
                data-settings-section={settingsView.id}
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
        <div className={`settings-content${activeView === 'agents' && !navigation.route.page ? ' settings-agent-overview' : ''}`}>
        {navigation.route.page && navigation.route.page !== 'extension' && <SettingsBackLink label={settingsSections.find((section) => section.id === activeView)!.label} onBack={navigation.back} />}
        {activeView === 'general' && (navigation.route.page === 'diagnostics' ? <DiagnosticsSettings onConnection={() => navigation.select('connection')} /> : <GeneralSettings onDiagnostics={() => navigation.open('general', 'diagnostics')} onboarding={onboarding} />)}

        <section hidden={activeView !== 'connection'} className="settings-section" aria-labelledby="connection-heading">
        <h2 id="connection-heading" className="sr-only">Connection</h2>
        <ProviderConnectionsSettings environmentRevision={environmentRevision} />
        <div hidden={!!navigation.route.page} className="settings-block">
          <ComputeSettings onEnvironmentChanged={() => setEnvironmentRevision((revision) => revision + 1)} />
          <details><summary>Connection details &amp; recovery</summary><ServerAgentSettings view="recovery" /></details>
        </div>
      </section>

      <div hidden={activeView !== 'agents'} className="settings-view" aria-label="Agent settings">
        <AgentSettings extensionTools={extensionTools} extensionExecutors={extensionExecutors} reportError={(error) => setActionError(describeError(error))} />
      </div>

      <section hidden={activeView !== 'agents' || !!navigation.route.page} className="settings-section settings-group settings-tools-section" aria-labelledby="tools-heading">
        <div className="settings-heading-copy">
        <h2 id="tools-heading">Tools</h2>
        <p className="settings-hint">
          Enable built-in tools here. Manage extension tools in Extensions and server tools in MCP servers. Agents must also allow each tool.
        </p>
        </div>
        <h3>Built-in</h3>
        <div className="settings-row-list">
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
        {customTools.length > 0 && <><h3>Custom HTTP</h3><div className="settings-row-list">
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

      <div hidden={activeView !== 'agents' || !!navigation.route.page} className="settings-view">
        <ServerAgentSettings view="rules" />
      </div>

        {activeView === 'extensions' && (
          <div className="settings-view">
            <ExtensionsSettings onConfigureTools={() => setActiveView('agents')} />
          </div>
        )}

        {activeView === 'mcp' && <McpSettings />}

        {(actionError || storeError) && (
          <p className="settings-error" role="alert">{actionError || storeError}</p>
        )}
        </div>
      </div>
    </div>
    </SettingsNavigationProvider>
  )
}
import './settings.css'
