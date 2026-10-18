import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Field'
import { ProviderConnectionsSettings } from '../components/Settings/ProviderConnectionsSettings'
import { useSettingsStore } from '../store/settingsStore'
import { statusLabel, useExtensionStore } from '../store/extensionStore'
import { useMcpStore } from '../store/mcpStore'
import { mcpConnectionAvailable } from '@forage/agent-runtime'
import { useOnboardingStore, steps } from './progress'
import { mcpReference, usableCompute, type OnboardingController } from './useOnboarding'
import { ExtensionSetup } from './ExtensionSetup'
import { McpSetup } from './McpSetup'
import './onboarding.css'

const copy = {
  note: ['01 / 05 · YOUR FIRST NOTE', 'Start with a note', 'Write something you want to explore. Add a detail underneath it.'],
  ai: ['02 / 05 · CONNECT AI', 'Connect your AI', 'Connect a provider and choose a default model. You can also keep writing without AI.'],
  command: ['03 / 05 · YOUR FIRST COMMAND', 'Explore your note', 'Ask your assistant to brainstorm using the note you just wrote.'],
  extensions: ['04 / 05 · EXTENSIONS', 'Make room for more', 'Add optional capabilities to your outline.'],
  mcp: ['05 / 05 · MCP CONNECTIONS', 'Connect your tools', 'Bring in connections you already use, or add a server.'],
  complete: ['SETUP COMPLETE', 'Your outline is ready', 'Keep gathering notes, exploring ideas, and making them your own.'],
} as const

export function OnboardingShell({ controller: setup, children }: { controller: OnboardingController; children: ReactNode }) {
  const settings = useSettingsStore()
  const extensions = useExtensionStore()
  const mcp = useMcpStore()
  const [selected, setSelected] = useState<string[]>([])
  const [configuring, setConfiguring] = useState(false)
  const [configured, setConfigured] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const progress = setup.progress
  const step = progress?.step ?? 'note'
  useEffect(() => { if (setup.active) heading.current?.focus(); setConfiguring(false) }, [setup.active, step])
  const busy = setup.busy || setup.running || extensions.busyInstallationId !== null || mcp.busy || !!mcp.authorizationProgress
  const title = step === 'command' && setup.hasResult ? 'Make the ideas your own' : copy[step][1]
  const saveMcp = () => setup.act(async () => {
    await useOnboardingStore.getState().update({ step: 'complete', mcp: await Promise.all(useMcpStore.getState().connections.map(mcpReference)) })
  })
  return <div className={setup.active ? 'onboarding-shell' : 'onboarding-inactive'} data-step={setup.active ? step : undefined}>
    <div className={setup.active ? 'onboarding-body' : 'onboarding-inactive'}>
    {setup.active && <header className="onboarding-heading">
      <p className="onboarding-step">{copy[step][0]}</p>
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
      <p>{step === 'command' && setup.hasResult ? 'These are your assistant’s ideas. Edit them directly, just like any other note.' : copy[step][2]}</p>
    </header>}
    {children}
    {setup.active && <>
      {step === 'note' && <div className="onboarding-hints"><p>Enter adds a bullet. Tab nests it. Shift + Tab moves it back out.</p><p>This note stays in your outline. You can undo your edits as usual.</p></div>}
      {step === 'ai' && <ProviderConnectionsSettings />}
      {step === 'command' && <div className="settings-block">
        <p className="settings-hint">Context: “{setup.note?.text ?? 'Note unavailable'}” and its details. This context is sent to your chosen AI provider when you run the command.</p>
        {!setup.hasResult && <form aria-label="First command" onSubmit={event => { event.preventDefault(); if (!busy) void setup.runCommand() }}>
          <label className="settings-field-label" htmlFor="onboarding-command">Your request</label>
          <Input id="onboarding-command" value={setup.prompt} disabled={busy} onChange={event => setup.setPrompt(event.target.value)} />
          <div className="settings-actions"><Button type="submit" disabled={busy} variant="primary">{setup.running ? 'Thinking…' : 'Run command'}</Button>{setup.running && <Button onClick={setup.cancelRun}>Cancel command</Button>}</div>
        </form>}
      </div>}
      {step === 'extensions' && <ExtensionSetup selected={selected} setSelected={value => { setSelected(value); setConfigured(false) }} configuring={configuring} onConfigured={() => { setConfiguring(false); setConfigured(true) }} />}
      {step === 'mcp' && <McpSetup />}
      {step === 'complete' && <div className="onboarding-summary" aria-label="Saved setup">
        <div className="onboarding-summary-row"><strong>Your note</strong><p>{setup.note?.text ?? 'Your outline is available. Add a note whenever you’re ready.'}</p></div>
        <div className="onboarding-summary-row"><strong>AI</strong><p>{usableCompute() ? `${settings.localCompute.provider} · ${settings.localCompute.modelId}` : 'Skipped · Your notes work without an AI account.'}</p></div>
        <div className="onboarding-summary-row"><strong>First command</strong><p>{setup.hasResult ? 'Result saved in your outline.' : 'Skipped or unfinished · Run a command whenever you’re ready.'}</p></div>
        <div className="onboarding-summary-row"><strong>Extensions</strong><p>{extensions.catalog?.entries.length ? extensions.catalog.entries.map(entry => `${entry.manifest?.name ?? 'Extension'}: ${statusLabel(entry)}`).join(' · ') : 'Skipped · You can add extensions in Settings.'}</p></div>
        <div className="onboarding-summary-row"><strong>MCP connections</strong>{mcp.connections.length ? <>{mcp.connections.map(connection => {
          const tools = connection.tools.filter(tool => settings.enabledToolIds.includes(tool.id) && mcpConnectionAvailable(connection))
          const assistants = settings.agents.filter(agent => agent.toolIds.some(id => tools.some(tool => tool.id === id)))
          return <p key={connection.id}>{connection.name}: {tools.length} tools available · {assistants.length} assistants with access.</p>
        })}<p>Review tool and assistant access in Settings → MCP servers.</p></> : <p>Skipped · You can connect tools in Settings → MCP servers.</p>}</div>
      </div>}
      {setup.error && <p role="alert" className="settings-error onboarding-error">{setup.error}</p>}
    </>}
    </div>
    {setup.active && <footer className="onboarding-navigation" aria-label="Setup navigation">
      <div>{step === 'note' ? <Button disabled={busy} onClick={() => void setup.finish('skipped')}>Skip setup</Button> : <Button disabled={busy} onClick={() => void setup.go(step === 'extensions' && progress?.skipped.includes('ai') ? 'ai' : steps[Math.max(0, steps.indexOf(step) - 1)])}>Back</Button>}</div>
      <div className="onboarding-navigation-actions">
        {step !== 'note' && step !== 'complete' && <Button variant="ghost" disabled={busy} onClick={() => void setup.finish('paused')}>Finish later</Button>}
        {step === 'note' && <Button variant="primary" disabled={busy || !setup.canContinueNote} onClick={() => void setup.continueNote()}>Continue</Button>}
        {step === 'ai' && <><Button disabled={busy} onClick={() => void setup.skip('ai', 'extensions')}>Skip for now</Button><Button variant="primary" disabled={busy || !usableCompute()} onClick={() => void setup.confirmCompute()}>Confirm model &amp; continue</Button></>}
        {step === 'command' && <><Button disabled={busy} onClick={() => void setup.skip('command', 'extensions')}>Skip for now</Button><Button variant="primary" disabled={busy || !setup.hasResult} onClick={() => void setup.go('extensions')}>Continue</Button></>}
        {step === 'extensions' && <><Button disabled={busy} onClick={() => void setup.skip('extensions', 'mcp')}>Skip for now</Button><Button variant="primary" disabled={busy || (!configuring && !configured && selected.length === 0)} onClick={() => configuring || configured ? void setup.go('mcp') : setConfiguring(true)}>{configuring || configured ? 'Continue' : 'Configure selected'}</Button></>}
        {step === 'mcp' && <><Button disabled={busy} onClick={() => void setup.skip('mcp', 'complete')}>Skip for now</Button><Button variant="primary" disabled={busy || !mcp.loaded} onClick={() => void saveMcp()}>Continue</Button></>}
        {step === 'complete' && <Button disabled={busy} variant="primary" onClick={() => void setup.finish('completed')}>Open Forage</Button>}
      </div>
    </footer>}
  </div>
}
