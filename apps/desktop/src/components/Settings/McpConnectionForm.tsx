import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMcpStore } from '../../store/mcpStore'
import { Button } from '../ui/Button'
import { Field, Input, Textarea } from '../ui/Field'
import { SegmentedControl } from '../ui/SegmentedControl'
import { parseMcpCommand } from './mcpCommand'
import type { McpConnection } from '@forage/agent-runtime'
import { useDraftExit } from './useDraftExit'
import { mcpSettingsError } from './mcpPresentation'
import { McpAuthorizationWaiting } from './McpAuthorizationWaiting'

type Entry = { name: string; value: string }

function values(entries: Entry[], caseInsensitive = false): Record<string, string> {
  const result: Array<[string, string]> = []
  const names = new Set<string>()
  for (const entry of entries) {
    const name = entry.name.trim()
    if (!name && !entry.value) continue
    if (!name) throw new Error('Give each credential or environment variable a name.')
    const key = caseInsensitive ? name.toLowerCase() : name
    if (names.has(key)) throw new Error('Each credential or environment variable must have a unique name.')
    names.add(key)
    result.push([name, entry.value])
  }
  return Object.fromEntries(result)
}

function ConfigurationEntries({ label, entries, onChange, showEmpty = false }: { label: string; entries: Entry[]; onChange: (entries: Entry[]) => void; showEmpty?: boolean }) {
  const visibleEntries = showEmpty && !entries.length ? [{ name: '', value: '' }] : entries
  return <div className="flex flex-col gap-2">
    {visibleEntries.map((entry, index) => <div className={`settings-configuration-entry${entries.length ? ' has-actions' : ''}`} key={index}>
      <Field className="min-w-0 flex-1" label={`${label} name ${index + 1}`}><Input value={entry.name} onChange={(event) => onChange(visibleEntries.map((before, position) => position === index ? { ...before, name: event.target.value } : before))} autoComplete="off" spellCheck={false} /></Field>
      <Field className="min-w-0 flex-1" label={`${label} value ${index + 1}`}><Input type="password" value={entry.value} onChange={(event) => onChange(visibleEntries.map((before, position) => position === index ? { ...before, value: event.target.value } : before))} autoComplete="off" /></Field>
      {entries.length > 0 && <Button aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} onClick={() => onChange(entries.filter((_, position) => position !== index))}>Remove</Button>}
    </div>)}
    <Button className="self-start" disabled={entries.length >= 64} onClick={() => onChange([...visibleEntries, { name: '', value: '' }])}>Add {label.toLowerCase()}</Button>
  </div>
}

export function McpConnectionForm({ onConnected, onCancel = () => undefined }: { onConnected?: (connections: McpConnection[]) => void; onCancel?: () => void }) {
  const busy = useMcpStore((state) => state.busy)
  const progress = useMcpStore((state) => state.authorizationProgress)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'url' | 'command'>('url')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [authentication, setAuthentication] = useState<'oauth' | 'manual' | 'none'>('oauth')
  const [clientId, setClientId] = useState('')
  const [clientMetadataUrl, setClientMetadataUrl] = useState('')
  const [noneHeaders, setNoneHeaders] = useState<Entry[]>([])
  const cancelled = useRef(false)
  useEffect(() => () => { void useMcpStore.getState().cancelAuthorization() }, [])
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('')
  const [headers, setHeaders] = useState<Entry[]>([])
  const [env, setEnv] = useState<Entry[]>([])
  const [json, setJson] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const disabled = busy || submitting
  const exit = useDraftExit(!!(name || url || token || command || cwd || headers.length || noneHeaders.length || env.length || json || clientId || clientMetadataUrl), disabled && !progress, () => { void useMcpStore.getState().cancelAuthorization(); onCancel() })
  const reset = () => { setName(''); setUrl(''); setToken(''); setCommand(''); setCwd(''); setHeaders([]); setEnv([]); setJson('') }
  const perform = async (action: () => Promise<McpConnection[]>) => {
    setError(null)
    cancelled.current = false
    setSubmitting(true)
    try { const connected = await action(); reset(); exit.allowExit(); onConnected?.(connected) }
    catch (cause) { if (!cancelled.current) setError(mcpSettingsError(cause, 'Could not connect to the server. Check its setup and try again. Any connections already imported remain saved, without tool access.')) }
    finally { setSubmitting(false) }
  }
  const connect = (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    void perform(async () => {
      if (kind === 'url') {
        if (authentication === 'oauth') return [await useMcpStore.getState().addConnection(name, { url: url.trim(), headers: {}, authentication: {
          method: 'oauth', ...(clientId.trim() ? { clientId: clientId.trim() } : {}), ...(clientMetadataUrl.trim() ? { clientMetadataUrl: clientMetadataUrl.trim() } : {}),
        } })]
        const configuredHeaders = values(authentication === 'manual' ? headers : noneHeaders, true)
        if (authentication === 'manual' && token.trim()) {
          if (Object.keys(configuredHeaders).some((key) => key.toLowerCase() === 'authorization')) throw new Error('Use either the access token or an Authorization header.')
          configuredHeaders.Authorization = `Bearer ${token.trim()}`
        }
        return [await useMcpStore.getState().addConnection(name, { url: url.trim(), headers: configuredHeaders, authentication: { method: authentication } })]
      } else {
        return [await useMcpStore.getState().addConnection(name, { ...parseMcpCommand(command.trim()), env: values(env), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) })]
      }
    })
  }
  return <div className="custom-tool-form mcp-connection-form">
    <form onSubmit={connect} aria-label="Connect MCP server">
      <fieldset disabled={disabled} className="settings-block settings-editor-fieldset">
        <div className="settings-block settings-connection-method"><span className="settings-field-label">Connect using</span><SegmentedControl ariaLabel="Connect using" value={kind} options={[{ value: 'url', label: 'Server URL' }, { value: 'command', label: 'Launch command' }]} onValueChange={(value) => { setKind(value); setError(null) }} /></div>
        <Field label="Server name"><Input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="My search server" autoComplete="off" /></Field>
        {kind === 'url' ? <>
          <Field label="Server URL"><Input required type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" autoComplete="off" spellCheck={false} /></Field>
          <div className="settings-block"><span className="settings-field-label">Authentication</span><SegmentedControl ariaLabel="Authentication" value={authentication} options={[{ value: 'oauth', label: 'Browser sign-in' }, { value: 'manual', label: 'Manual credentials' }, { value: 'none', label: 'None' }]} onValueChange={(value) => { setAuthentication(value); setError(null) }} /></div>
          {authentication === 'oauth' ? <>
            <p className="settings-hint">Sign in to this server in your browser. No API token to create or paste.</p><p className="settings-hint">Forage stores authorization on this device and refreshes it automatically when supported.</p>
            <details><summary className="cursor-pointer text-sm">Advanced sign-in setup</summary><div className="settings-block mt-3">
              <Field label="Public client ID (optional)" hint="Use a client registered for Forage and a native loopback callback. No client secret."><Input value={clientId} maxLength={2000} onChange={(event) => setClientId(event.target.value)} autoComplete="off" /></Field>
              <Field label="Client metadata URL (optional)" hint="An HTTPS metadata document you control. Otherwise the server must support public-client registration."><Input type="url" value={clientMetadataUrl} maxLength={2000} onChange={(event) => setClientMetadataUrl(event.target.value)} autoComplete="off" /></Field>
            </div></details>
          </> : <>
            {authentication === 'manual' ? <Field label="Access token (optional)" htmlFor="mcp-access-token" hint="Sent as a Bearer token. Use this or an Authorization header, not both."><Input id="mcp-access-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" /></Field> : <p className="settings-hint">Connect without authentication. Authorization headers are not allowed.</p>}
            <details><summary className="cursor-pointer text-sm">Additional headers</summary><div className="mt-3"><ConfigurationEntries label="Header" entries={authentication === 'manual' ? headers : noneHeaders} onChange={authentication === 'manual' ? setHeaders : setNoneHeaders} /></div></details>
          </>}
        </> : <>
          <Field label="Launch command" htmlFor="mcp-launch-command" hint="Paste the server’s launch command. Quote paths or arguments that contain spaces."><Input id="mcp-launch-command" required value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx -y your-mcp-package" autoComplete="off" spellCheck={false} /></Field>
          <div className="settings-block"><h3>Environment variables</h3><p className="settings-hint">Add credentials or other values the server needs when it starts.</p><ConfigurationEntries label="Environment variable" entries={env} onChange={setEnv} showEmpty /></div>
          <details><summary className="cursor-pointer text-sm">Working directory</summary><Field label="Working directory (optional)" className="mt-3"><Input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/absolute/path" autoComplete="off" /></Field></details>
          <p className="settings-hint">Connecting runs this command with your permissions. Runners such as npx or uvx may download code; only use servers you trust. Install the required Node or Python runtime first.</p>
        </>}
        {!progress && <div className="settings-actions"><Button type="submit" variant="primary" disabled={disabled || !name.trim() || !(kind === 'url' ? url.trim() : command.trim())}>{submitting ? 'Connecting…' : kind === 'url' && authentication === 'oauth' ? error ? 'Try sign-in again' : 'Sign in and connect' : 'Connect server'}</Button><Button disabled={disabled} onClick={exit.cancel}>Cancel</Button></div>}
      </fieldset>
    </form>
    {progress && <McpAuthorizationWaiting progress={progress} onCancel={() => { cancelled.current = true; void useMcpStore.getState().cancelAuthorization(); setError(null) }} />}
    <details className="settings-divider">
      <summary className="cursor-pointer text-sm">Import existing JSON configuration</summary>
      <div className="mt-3 flex flex-col gap-3">
        <Field label="Server configuration"><Textarea value={json} onChange={(event) => setJson(event.target.value)} disabled={disabled} placeholder={'{ "mcpServers": { "my-server": { "command": "npx", "args": ["-y", "your-mcp-package"] } } }'} rows={7} spellCheck={false} autoComplete="off" /></Field>
        <p className="settings-hint">Import mcpServers configuration from a server’s setup guide. Commands run with your permissions and may download code; only import servers you trust.</p>
        <Button className="self-start" disabled={disabled || !json.trim()} onClick={() => void perform(() => useMcpStore.getState().importConnections(json))}>Import and connect</Button>
      </div>
    </details>
    <p className="settings-hint settings-footnote">Have an existing setup? Import its mcpServers JSON configuration above.</p>
    <p className="settings-hint">Configuration and credentials stay on this device.</p>
    <p className="settings-hint">Next, choose the tools and agents that can use this server. Connecting grants no access.</p>
    {error && <div className="settings-error" role="alert">{kind === 'url' && authentication === 'oauth' && <h3>Sign-in wasn’t completed</h3>}<p>{error}</p>{kind === 'url' && authentication === 'oauth' && <p>No connection or tool access was saved. Your connection details are retained.</p>}</div>}
    {exit.dialog}
  </div>
}
