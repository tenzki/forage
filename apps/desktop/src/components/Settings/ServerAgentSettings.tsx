import { useEffect, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { CredentialMetadata } from '@forage/protocol'
import { TauriServerAgentTransport } from '../../agent/serverExecutor'
import { useSettingsStore } from '../../store/settingsStore'
import type { ServerConnectionInfo } from '../../persistence/eventStore'
import { invoke } from '@tauri-apps/api/core'
import { OUTLINE_INTERNAL_LINK_EVENT } from '../../editor/internalLinks'

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
type RunDetail = Awaited<ReturnType<TauriServerAgentTransport['run']>>
type RunSummary = Awaited<ReturnType<TauriServerAgentTransport['runs']>>['runs'][number]
type RunActivity = Awaited<ReturnType<TauriServerAgentTransport['activity']>>['events'][number]
type LinkPolicyId = 'youtube' | 'x' | 'web'
const linkPolicies: Record<LinkPolicyId, { id: string; label: string; urlType: LinkPolicyId | 'webpage' }> = {
  youtube: { id: 'youtube-links', label: 'YouTube links', urlType: 'youtube' },
  x: { id: 'x-links', label: 'X links', urlType: 'x' },
  web: { id: 'web-links', label: 'Web links', urlType: 'webpage' },
}

export function ServerAgentSettings() {
  const agents = useSettingsStore((state) => state.agents)
  const skills = useSettingsStore((state) => state.skills)
  const customTools = useSettingsStore((state) => state.customTools)
  const enabledToolIds = useSettingsStore((state) => state.enabledToolIds)
  const [connection, setConnection] = useState<ServerConnectionInfo | null>(null)
  const [revision, setRevision] = useState(0)
  const [credential, setCredential] = useState<CredentialMetadata | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [policyOrder, setPolicyOrder] = useState<LinkPolicyId[]>(['youtube', 'x', 'web'])
  const [policySkills, setPolicySkills] = useState<Record<LinkPolicyId, string>>({
    youtube: skills[0]?.id ?? '', x: skills[0]?.id ?? '', web: skills[0]?.id ?? '',
  })
  const [automationEnabled, setAutomationEnabled] = useState(false)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null)
  const [runActivity, setRunActivity] = useState<RunActivity[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const transport = new TauriServerAgentTransport()

  useEffect(() => {
    void invoke<ServerConnectionInfo | null>('server_connection_info').then(async (value) => {
      setConnection(value)
      if (!value) return
      try {
        const published = await transport.configuration()
        setRevision(published.configuration.revision)
        const reference = published.configuration.agents.find((agent) => agent.credentialRef)?.credentialRef
        if (reference) setCredential(await transport.credential(reference))
      } catch { /* the first publication starts at revision zero */ }
      try { setRuns((await transport.runs(undefined, 20)).runs) } catch { /* history is optional while offline */ }
    }).catch((error) => setStatus(message(error)))
  }, [])

  async function enrollApiKey() {
    setBusy(true); setStatus(null)
    try {
      const enrolled = await transport.enrollApiKey({ provider: 'openai', apiKey: apiKey.trim() })
      setCredential(enrolled); setApiKey(''); setStatus('Server API key enrolled securely.')
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function connectChatGpt() {
    setBusy(true); setStatus(null)
    try {
      const authorization = await transport.startDeviceAuthorization()
      await openUrl(authorization.verificationUri)
      setStatus(`Enter ${authorization.userCode} in the browser, then click Check ChatGPT login.`)
      sessionStorage.setItem('forage-server-authorization', authorization.authorizationId)
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function checkChatGpt() {
    const authorizationId = sessionStorage.getItem('forage-server-authorization')
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
    setBusy(true); setStatus(null)
    try {
      const nextRevision = revision + 1
      const published = await transport.publishConfiguration({
        baseRevision: revision,
        configuration: {
          version: 1, revision: nextRevision,
          agents: agents.map((agent) => ({ ...agent, credentialRef: credential.id })),
          skills, customTools, globallyEnabledToolIds: enabledToolIds,
        },
      })
      setRevision(published.configuration.revision)
      setStatus(`Published server agent configuration revision ${published.configuration.revision}.`)
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function publishAutomation() {
    if (policyOrder.some((kind) => !policySkills[kind])) return setStatus('Choose a skill for every captured link type.')
    setBusy(true); setStatus(null)
    try {
      const current = await transport.automation() as { published?: { policies?: { revision?: number } } | null }
      const baseRevision = current.published?.policies?.revision ?? 0
      await transport.publishAutomation({
        baseRevision,
        policies: {
          version: 1, revision: baseRevision + 1, enabled: automationEnabled,
          policies: policyOrder.map((kind, index) => {
            const policy = linkPolicies[kind]
            return {
              id: policy.id, name: policy.label, enabled: automationEnabled,
              priority: policyOrder.length - index, match: { urlTypes: [policy.urlType] },
              skillIds: [policySkills[kind]], dispatcher: { enabled: false, allowedSkillIds: [] },
            }
          }),
        },
      })
      setStatus(automationEnabled ? 'Inbox link automation enabled.' : 'Disabled link policies published.')
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function disconnectCredential() {
    if (!credential) return
    setBusy(true)
    try { setCredential(await transport.disconnectCredential(credential.id)); setStatus('Server credential disconnected.') }
    catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function inspectRun(runId: string) {
    setBusy(true); setStatus(null)
    try {
      const [detail, activity] = await Promise.all([transport.run(runId), transport.activity(runId, 0, 200)])
      setSelectedRun(detail); setRunActivity(activity.events)
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function cancelRun() {
    if (!selectedRun) return
    setBusy(true); setStatus(null)
    try {
      await transport.cancel(selectedRun.id)
      setStatus('Run cancellation requested.')
      await inspectRun(selectedRun.id)
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  async function retryRun() {
    if (!selectedRun) return
    setBusy(true); setStatus(null)
    try {
      const retried = await transport.retry(selectedRun.id)
      setStatus(`Retry queued as ${retried.runId}.`)
      const page = await transport.runs(undefined, 20)
      setRuns(page.runs)
      await inspectRun(retried.runId)
    } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
  }

  function openResult() {
    const targetId = selectedRun?.result?.rootNoteIds[0]
    if (targetId) window.dispatchEvent(new CustomEvent(OUTLINE_INTERNAL_LINK_EVENT, { detail: { targetId } }))
  }

  function movePolicy(kind: LinkPolicyId, direction: -1 | 1) {
    setPolicyOrder((current) => {
      const from = current.indexOf(kind)
      const to = from + direction
      if (from < 0 || to < 0 || to >= current.length) return current
      const next = [...current]
      ;[next[from], next[to]] = [next[to]!, next[from]!]
      return next
    })
  }

  if (!connection) return null
  return (
    <div className="auth-card server-agent-settings">
      <strong>Server agent executor</strong>
      <p className="settings-hint">Runs continue on {connection.origin} while this app is closed. Server mode never falls back to local execution.</p>
      <p className="settings-hint">Configuration revision: {revision || 'not published'} · Credential: {credential?.status ?? 'not enrolled'}</p>
      <label htmlFor="server-openai-key">Server OpenAI API key</label>
      <input id="server-openai-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" autoComplete="off" />
      <div className="settings-actions">
        <button className="settings-save" disabled={busy || apiKey.trim().length < 20} onClick={() => void enrollApiKey()}>Enroll API key</button>
        <button className="settings-secondary" disabled={busy} onClick={() => void connectChatGpt()}>Connect ChatGPT</button>
        <button className="settings-secondary" disabled={busy} onClick={() => void checkChatGpt()}>Check ChatGPT login</button>
        {credential?.status === 'connected' && <button className="settings-secondary" disabled={busy} onClick={() => void disconnectCredential()}>Disconnect credential</button>}
      </div>
      <button className="settings-save" disabled={busy || credential?.status !== 'connected'} onClick={() => void publishConfiguration()}>Publish agents and skills</button>
      <hr />
      <strong>Ordered link policies</strong>
      <ol data-testid="automation-policy-order">{policyOrder.map((kind, index) => {
        const policy = linkPolicies[kind]
        const selectId = `automation-skill-${kind}`
        return <li key={kind}>
          <label htmlFor={selectId}>Skill for {policy.label}</label>
          <select id={selectId} value={policySkills[kind]} onChange={(event) => setPolicySkills((current) => ({ ...current, [kind]: event.target.value }))}>
            <option value="">Choose a skill</option>
            {skills.map((skill) => <option key={skill.id} value={skill.id}>/{skill.label}</option>)}
          </select>
          <button className="settings-secondary" disabled={index === 0} aria-label={`Move ${policy.label} up`} onClick={() => movePolicy(kind, -1)}>↑</button>
          <button className="settings-secondary" disabled={index === policyOrder.length - 1} aria-label={`Move ${policy.label} down`} onClick={() => movePolicy(kind, 1)}>↓</button>
        </li>
      })}</ol>
      <label className="tool-setting"><span>Enable Inbox link automation</span><input type="checkbox" checked={automationEnabled} onChange={(event) => setAutomationEnabled(event.target.checked)} /></label>
      <button className="settings-save" disabled={busy || revision === 0} onClick={() => void publishAutomation()}>Publish link policies</button>
      {runs.length > 0 && <div><strong>Recent runs</strong><ul>{runs.map((run) => <li key={run.id}>
        <button className="settings-secondary" disabled={busy} onClick={() => void inspectRun(run.id)} aria-label={`View /${run.skillId} ${run.status}`}>
          /{run.skillId} · {run.status} · {new Date(run.admittedAt).toLocaleString()}
        </button>
      </li>)}</ul></div>}
      {selectedRun && <div className="server-run-detail">
        <strong>Run /{selectedRun.skillId}</strong>
        <p className="settings-hint">Status: {selectedRun.status} · Attempts: {selectedRun.attemptCount}</p>
        <p className="settings-hint">Policy: {selectedRun.policyId ?? 'manual invocation'}</p>
        {selectedRun.error && <p role="alert">{selectedRun.error.message}</p>}
        <div className="settings-actions">
          {['queued', 'running', 'retry_wait'].includes(selectedRun.status) && <button className="settings-secondary" disabled={busy} onClick={() => void cancelRun()}>Cancel run</button>}
          {['failed', 'cancelled', 'interrupted'].includes(selectedRun.status) && <button className="settings-secondary" disabled={busy} onClick={() => void retryRun()}>Retry run</button>}
          {selectedRun.result?.rootNoteIds.length && <button className="settings-secondary" onClick={openResult}>Open result</button>}
        </div>
        {runActivity.length > 0 && <><strong>Activity</strong><ol>{runActivity.map((event) => <li key={`${event.sequence}:${event.id}`}>{event.label}</li>)}</ol></>}
      </div>}
      {status && <p role="status" className="settings-hint">{status}</p>}
    </div>
  )
}
