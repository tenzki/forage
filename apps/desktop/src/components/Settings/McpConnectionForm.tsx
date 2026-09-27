import { useState, type FormEvent } from 'react'
import { useMcpStore } from '../../store/mcpStore'
import { Button } from '../ui/Button'
import { Field, Input, Select, Textarea } from '../ui/Field'
import { parseMcpCommand } from './mcpCommand'

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

function ConfigurationEntries({ label, entries, onChange }: { label: string; entries: Entry[]; onChange: (entries: Entry[]) => void }) {
  return <div className="flex flex-col gap-2">
    {entries.map((entry, index) => <div className="flex items-end gap-2" key={index}>
      <Field label={`${label} name ${index + 1}`}><Input value={entry.name} onChange={(event) => onChange(entries.map((before, i) => i === index ? { ...before, name: event.target.value } : before))} autoComplete="off" spellCheck={false} /></Field>
      <Field label={`${label} value ${index + 1}`}><Input type="password" value={entry.value} onChange={(event) => onChange(entries.map((before, i) => i === index ? { ...before, value: event.target.value } : before))} autoComplete="off" /></Field>
      <Button aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} onClick={() => onChange(entries.filter((_, i) => i !== index))}>Remove</Button>
    </div>)}
    <Button className="self-start" disabled={entries.length >= 64} onClick={() => onChange([...entries, { name: '', value: '' }])}>Add {label.toLowerCase()}</Button>
  </div>
}

export function McpConnectionForm() {
  const busy = useMcpStore((state) => state.busy)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'url' | 'command'>('url')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('')
  const [headers, setHeaders] = useState<Entry[]>([])
  const [env, setEnv] = useState<Entry[]>([])
  const [json, setJson] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const disabled = busy || submitting
  const reset = () => { setName(''); setUrl(''); setToken(''); setCommand(''); setCwd(''); setHeaders([]); setEnv([]); setJson('') }
  const perform = async (action: () => Promise<void>) => {
    setError(null)
    setSubmitting(true)
    try { await action(); reset() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not connect to the server.') }
    finally { setSubmitting(false) }
  }
  const connect = (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    void perform(async () => {
      if (kind === 'url') {
        const configuredHeaders = values(headers, true)
        if (token.trim()) {
          if (Object.keys(configuredHeaders).some((key) => key.toLowerCase() === 'authorization')) throw new Error('Use either the access token or an Authorization header.')
          configuredHeaders.Authorization = `Bearer ${token.trim()}`
        }
        await useMcpStore.getState().addConnection(name, { url: url.trim(), headers: configuredHeaders })
      } else {
        await useMcpStore.getState().addConnection(name, { ...parseMcpCommand(command.trim()), env: values(env), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) })
      }
    })
  }
  return <div className="custom-tool-form">
    <form onSubmit={connect} aria-label="Connect MCP server">
      <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <Field label="Server name"><Input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="My search server" autoComplete="off" /></Field>
        <Field label="Connect using"><Select value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); setError(null) }}>
          <option value="url">Server URL</option><option value="command">Launch command</option>
        </Select></Field>
        {kind === 'url' ? <>
          <Field label="Server URL"><Input required type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" autoComplete="off" spellCheck={false} /></Field>
          <Field label="Access token (optional)" htmlFor="mcp-access-token" hint="Sent as a Bearer token. Leave blank if the server does not require one."><Input id="mcp-access-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" /></Field>
          <p className="settings-hint">Use the server’s Streamable HTTP URL. Browser sign-in (OAuth) is not supported yet.</p>
          <details><summary className="cursor-pointer text-sm">Additional headers</summary><div className="mt-3"><ConfigurationEntries label="Header" entries={headers} onChange={setHeaders} /></div></details>
        </> : <>
          <Field label="Launch command" htmlFor="mcp-launch-command" hint="Paste the server’s launch command. Quote paths or arguments that contain spaces."><Input id="mcp-launch-command" required value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx -y your-mcp-package" autoComplete="off" spellCheck={false} /></Field>
          <ConfigurationEntries label="Environment variable" entries={env} onChange={setEnv} />
          <details><summary className="cursor-pointer text-sm">Working directory</summary><Field label="Working directory (optional)" className="mt-3"><Input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/absolute/path" autoComplete="off" /></Field></details>
          <p className="settings-hint">Connecting runs this command with your permissions. Runners such as npx or uvx may download code; only use servers you trust. Install the required Node or Python runtime first.</p>
        </>}
        <Button type="submit" variant="primary" className="self-start" disabled={disabled || !name.trim() || !(kind === 'url' ? url.trim() : command.trim())}>{submitting ? 'Connecting…' : 'Connect server'}</Button>
      </fieldset>
    </form>
    <details>
      <summary className="cursor-pointer text-sm">Advanced: import JSON</summary>
      <div className="mt-3 flex flex-col gap-3">
        <Field label="Server configuration"><Textarea value={json} onChange={(event) => setJson(event.target.value)} disabled={disabled} placeholder={'{ "mcpServers": { "my-server": { "command": "npx", "args": ["-y", "your-mcp-package"] } } }'} rows={7} spellCheck={false} autoComplete="off" /></Field>
        <p className="settings-hint">Import mcpServers configuration from a server’s setup guide. Commands run with your permissions and may download code; only import servers you trust.</p>
        <Button className="self-start" disabled={disabled || !json.trim()} onClick={() => void perform(() => useMcpStore.getState().importConnections(json))}>Import and connect</Button>
      </div>
    </details>
    <p className="settings-hint">Configuration and credentials stay on this device.</p>
    {error && <p className="settings-error" role="alert">{error}</p>}
  </div>
}
