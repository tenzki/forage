// Isolated native App fixture. Only provider/model transports are deterministic.
import { createRoot } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import type { LocalRunResult } from '@forage/agent-runtime'
import App from '../src/App'
import '../src/style.css'
import { useSettingsStore } from '../src/store/settingsStore'
import { useOnboardingStore } from '../src/onboarding/progress'
import { useExtensionStore } from '../src/store/extensionStore'
import { useMcpStore } from '../src/store/mcpStore'
import { LocalAgentExecutor } from '../src/agent/localExecutor'
import { NativeEventRepository } from '../src/persistence/eventStore'
import { nativeLocalCredentialVault } from '../src/agent/localCredentials'
import { appendChildBullet, collectBullets, findBullet } from '../src/editor/outlineModel'
import { documentEditor } from '../src/editor/documentAccess'
import { disableNativeTextAssistance } from '../src/nativeTextAssistance'
import { resolveResource } from '@tauri-apps/api/path'
import { Command } from '@tauri-apps/plugin-shell'

const sidecarDiagnostics: string[] = []
const spawnCommand = Command.prototype.spawn
Command.prototype.spawn = function () {
  this.stderr.on('data', line => { sidecarDiagnostics.push(String(line)) })
  return spawnCommand.call(this)
}

let scans = 0, runs = 0
let releaseAccount: (() => void) | undefined
let releaseRun: ((result: LocalRunResult) => void) | undefined
useSettingsStore.setState({ connectApiKey: async () => {
  await new Promise<void>(resolve => { releaseAccount = resolve })
  await nativeLocalCredentialVault.store('local-openai', 'fixture-key-never-sent')
  useSettingsStore.setState({ localCredentials: [{ id: 'local-openai', provider: 'openai', status: 'connected' }] })
} })
useMcpStore.setState({ loaded: true, connections: [], scanConnections: async () => { scans++; useMcpStore.setState({ discovery: { candidates: [], warnings: [] } }) } })
const repository = new NativeEventRepository()
const originalInvoke = LocalAgentExecutor.prototype.invoke
LocalAgentExecutor.prototype.invoke = function (input, options) {
  runs++
  const executor = new LocalAgentExecutor(repository, async () => new Promise<LocalRunResult>(resolve => { releaseRun = resolve }))
  return originalInvoke.call(executor, input, options)
}
disableNativeTextAssistance()
createRoot(document.getElementById('app')!).render(<App />)
const sleep = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms))
function require(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
async function until(predicate: () => unknown, message: string) {
  const start = performance.now()
  while (!predicate()) { if (performance.now() - start > 15000) throw new Error(`${message}: ${document.body.innerText}; fixture sidecars: ${sidecarDiagnostics.join('\n')}`); await sleep(20) }
}
const editor = () => document.querySelector<HTMLElement & { editor: Editor }>('.tiptap')!.editor
const owner = () => documentEditor(editor())
let originalEditor: Editor
async function step(value: string) { await until(() => document.querySelector(`.onboarding-shell[data-step="${value}"]`), `Missing ${value} step`); await sleep(100) }
async function click(label: string, footer = false) {
  let target: HTMLButtonElement | undefined
  await until(() => {
    target = [...document.querySelectorAll<HTMLButtonElement>(footer ? '.onboarding-navigation button' : 'button')].find(button => button.offsetWidth > 0 && button.textContent?.trim() === label && !button.disabled)
    return target
  }, `Missing enabled ${label} action`)
  target!.click(); await sleep(100)
}
function setValue(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
  require(input, `Missing ${selector}`)
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

function layout(label: string) {
  const shell = document.querySelector<HTMLElement>('.onboarding-shell')!
  const body = shell.querySelector<HTMLElement>('.onboarding-body')!
  const header = shell.querySelector<HTMLElement>('.onboarding-heading')!
  const navigation = shell.querySelector<HTMLElement>('.onboarding-navigation')!
  const b = body.getBoundingClientRect(), h = header.getBoundingClientRect(), n = navigation.getBoundingClientRect()
  require(shell && header, 'Missing onboarding presentation')
  require(document.querySelector<HTMLElement>('.outline-sidebar')!.offsetWidth === 0, 'Workspace sidebar leaked into setup')
  require(document.querySelector<HTMLElement>('.activity-sidebar')!.offsetWidth === 0, 'Activity leaked into setup')
  require(n.bottom <= innerHeight + 1 && n.top >= b.bottom - 1, 'Bottom navigation overlaps or escapes window')
  require(h.width <= 561 && h.width >= Math.min(300, innerWidth - 40), 'Content column width is incorrect')
  require(Math.abs(h.left - (innerWidth - h.width) / 2) < 2, 'Content column is not centered')
  require(body.scrollWidth <= body.clientWidth + 1, 'Setup has horizontal overflow')
  for (const button of navigation.querySelectorAll<HTMLButtonElement>('button')) {
    const rect = button.getBoundingClientRect()
    require(rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= n.top && rect.bottom <= n.bottom, 'Navigation control clipped')
  }
  require(editor() === originalEditor, 'Setup remounted the outline editor')
  require(runs <= 1, 'A step revisit repeated inference')
  return { label, width: innerWidth, height: innerHeight, column: { left: h.left, width: h.width }, navigation: { top: n.top, bottom: n.bottom }, scrollHeight: body.scrollHeight, bodyHeight: body.clientHeight, runs, scans }
}

const api = {
  async ready() {
    await until(() => !!document.querySelector('.tiptap') && useOnboardingStore.getState().loaded && useSettingsStore.getState().isLoaded && !useOnboardingStore.getState().busy, 'App failed to hydrate')
    originalEditor = editor()
    if (useOnboardingStore.getState().progress?.status === 'in-progress') await until(() => !!document.querySelector('.onboarding-shell'), 'Setup shell did not appear')
    await sleep(100)
    return { status: useOnboardingStore.getState().progress?.status, step: useOnboardingStore.getState().progress?.step, resources: await resolveResource('resources/pi/sidecar/dist/management.mjs') }
  },
  layout,
  negativeControl() {
    const main = document.querySelector<HTMLElement>('.outliner-main')!
    main.style.gridTemplateColumns = '220px minmax(0, 1fr) 320px'
    let detected = false
    try { layout('broken-grid-negative-control') } catch { detected = true }
    main.style.gridTemplateColumns = ''
    require(detected, 'Layout checks accepted a squeezed content column')
    return { brokenGridDetected: detected }
  },
  async note() {
    await step('note')
    const before = collectBullets(owner().state.doc).filter(bullet => bullet.systemRole === null)
    require(before.every(bullet => !bullet.text), 'Setup inserted sample content')
    const blank = before[0]
    editor().view.dispatch(editor().state.tr.insertText('Plan a useful project', blank.pos + 2))
    const detail = appendChildBullet(editor(), blank.id, 'I have one free afternoon')
    await click('Continue', true); await step('ai')
    require(useOnboardingStore.getState().progress?.noteId === blank.id, 'Note identity not saved')
    return { noteId: blank.id, detail }
  },
  async providerForm() {
    await click('Add provider'); setValue('#connection-provider', 'openai'); await sleep(50)
    setValue('#connection-key', 'fixture-key-never-sent'); await sleep(50)
    return layout('09B-provider-form')
  },
  async pendingProvider() { await click('Connect provider'); await until(() => !!releaseAccount, 'Provider never started'); return layout('09B-provider-pending') },
  async connectedProvider() {
    releaseAccount!(); await until(() => !document.querySelector('#connection-key'), 'Provider did not settle')
    setValue('#default-provider', 'openai'); await sleep(50); setValue('#default-model', 'gpt-5.5'); await sleep(50)
    await click('Save defaults')
    require(runs === 0, 'Connecting a provider ran inference')
    return layout('09C-connected')
  },
  async command() { await click('Confirm model & continue', true); await step('command'); require(runs === 0, 'Step entry ran inference'); return layout('09D-command') },
  focusCommand() { document.querySelector<HTMLInputElement>('#onboarding-command')!.focus(); return true },
  async pendingCommand() {
    await until(() => !!releaseRun, 'Native Enter did not start the command')
    // A duplicate form gesture while pending must not admit a second run.
    document.querySelector('form[aria-label="First command"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await sleep(100); require(runs === 1, 'Duplicate command admission')
    return layout('09D-command-pending')
  },
  async result() {
    releaseRun!({ version: 1, nodes: [{ type: 'text', text: 'Native onboarding idea' }], sources: [] })
    await until(() => document.querySelector('.onboarding-heading h1')?.textContent === 'Make the ideas your own', 'Result not acknowledged')
    const idea = collectBullets(owner().state.doc).find(bullet => bullet.text === 'Native onboarding idea')!
    require(idea, 'No real outline result')
    editor().view.dispatch(editor().state.tr.insertText(' edited', idea.pos + 2 + idea.node.firstChild!.content.size))
    const measured = layout('09E-result')
    await click('Continue', true); await step('extensions'); await click('Back', true); await step('command')
    require(runs === 1 && findBullet(owner().state.doc, idea.id)?.text.endsWith(' edited'), 'Back lost output or reran inference')
    await click('Continue', true); await step('extensions')
    return measured
  },
  async extensions() {
    require([...document.querySelectorAll<HTMLInputElement>('.onboarding-choice input')].every(input => !input.checked), 'Extensions were preselected')
    return layout('09F-extensions')
  },
  async configureExtension() {
    const choice = [...document.querySelectorAll<HTMLElement>('.onboarding-choice')].find(choice => choice.textContent?.includes('Text Stats'))!
    choice.querySelector<HTMLInputElement>('input')!.click()
    require(!(useExtensionStore.getState().catalog?.entries.length), 'Selecting installed a source')
    await click('Configure selected', true); await click('Review source')
    await until(() => !!document.querySelector('.extension-install-preview'), 'Packaged source preview unavailable')
    await click('Register source')
    await until(() => !!document.querySelector('.extension-detail'), 'Source not registered')
    const entry = useExtensionStore.getState().catalog!.entries[0]
    require(entry.status === 'needs_review', 'Registration implicitly enabled code')
    require(!useSettingsStore.getState().enabledToolIds.includes('text_stats'), 'Registration implicitly granted tool')
    return layout('09G-extension-configuration')
  },
  async mcp() { await click('Skip for now', true); await step('mcp'); require(scans === 0, 'MCP scanned on entry'); return layout('09H-mcp') },
  async mcpUrl() { await click('Add server'); return layout('09I-mcp-url') },
  async mcpCommand() { await click('Launch command'); return layout('09J-mcp-command') },
  async completion() {
    await click('Skip for now', true); await step('complete'); require(scans === 0, 'Skipping scanned MCP'); return layout('09K-complete')
  },
  async pause() { await useOnboardingStore.getState().update({ step: 'mcp' }); await step('mcp'); await click('Finish later', true); require(editor() === originalEditor, 'Pause remounted editor'); return api.persistence() },
  async persistence() {
    const identity = await repository.identity(), replay = await repository.loadReplayInput(identity.outlineId)
    require(replay, 'Missing durable outline')
    return { progress: useOnboardingStore.getState().progress, noteText: owner().state.doc.textContent, events: replay.events.length }
  },
  async restart() {
    require(useOnboardingStore.getState().progress?.status === 'paused', 'Pause marker lost')
    require(!document.querySelector('.onboarding-shell'), 'Paused setup reopened automatically')
    require(owner().state.doc.textContent.includes('Native onboarding idea edited'), 'Note/result lost on restart')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))
    await click('Resume setup'); await step('mcp'); require(runs === 0 && scans === 0, 'Resume repeated an external operation')
    return api.persistence()
  },
  async activeRestart() {
    require(useOnboardingStore.getState().progress?.status === 'in-progress', 'Active progress lost')
    await step('mcp')
    require(runs === 0 && scans === 0, 'Automatic resume replayed an external operation')
    await click('Skip for now', true); await step('complete'); await click('Open Forage', true)
    await until(() => !document.querySelector('.onboarding-shell'), 'Completion did not open workspace')
    return api.persistence()
  },
  async completedRestart() {
    require(useOnboardingStore.getState().progress?.status === 'completed', 'Completion marker lost')
    require(!document.querySelector('.onboarding-shell'), 'Completed setup reopened')
    require(owner().state.doc.textContent.includes('Native onboarding idea edited'), 'Completed outline lost')
    return api.persistence()
  },
}
Object.assign(window, { onboardingVerify: api })
