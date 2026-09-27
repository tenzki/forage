import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { mcpDiscoverySchema, mcpServerConfigSchema, type McpCandidate, type McpDiscovery, type McpServerConfig } from '@forage/agent-runtime'

const MAX_FILE_BYTES = 1_000_000
const SUPPORTED_FIELDS = new Set([
  'command', 'args', 'env', 'cwd', 'type', 'url', 'serverUrl', 'headers', 'http_headers',
  'env_vars', 'env_http_headers', 'bearer_token_env_var', 'enabled', 'disabled',
  // These host settings are replaced by Forage's own explicit permission review and deadlines.
  'autoApprove', 'alwaysAllow', 'startup_timeout_sec', 'startup_timeout_ms', 'tool_timeout_sec', 'required',
])
type ObjectValue = Record<string, unknown>
interface Source { name: string; path: string; format: 'toml' | 'json'; root: string }
export interface DiscoveryOptions { home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }
interface Entry { candidate: McpCandidate; config: ObjectValue }
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const canonical = (value: unknown): string => JSON.stringify(value, (_, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)

/** Only known user-level files; no recursive searches, project files, or credential databases. */
export function discoverySources(options: DiscoveryOptions = {}): Source[] {
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const config = platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? env.APPDATA ?? join(home, 'AppData', 'Roaming') : env.XDG_CONFIG_HOME ?? join(home, '.config')
  return [
    { name: 'Codex', path: join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'), format: 'toml', root: 'mcp_servers' },
    { name: 'Claude Desktop', path: join(config, 'Claude', 'claude_desktop_config.json'), format: 'json', root: 'mcpServers' },
    { name: 'Claude Code', path: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json'), format: 'json', root: 'mcpServers' },
    { name: 'Cursor', path: join(home, '.cursor', 'mcp.json'), format: 'json', root: 'mcpServers' },
    { name: 'VS Code', path: join(config, 'Code', 'User', 'mcp.json'), format: 'json', root: 'servers' },
  ]
}

async function readSource(source: Source): Promise<ObjectValue> {
  // NONBLOCK avoids hanging on a FIFO masquerading as a config file. fstat checks
  // the opened handle; reads are bounded even if a file changes after opening.
  const file = await open(source.path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid configuration file')
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
    let count = 0
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, null)
      if (!read.bytesRead) break
      count += read.bytesRead
    }
    if (count > MAX_FILE_BYTES) throw new Error('Configuration too large')
    const text = bytes.subarray(0, count).toString('utf8')
    if (source.format === 'toml') return object(parseToml(text))
    const errors: ParseError[] = []
    const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) throw new Error('Invalid JSON')
    return object(parsed)
  } finally { await file.close() }
}

function normalize(name: string, raw: unknown, source: Source, options: DiscoveryOptions): Entry {
  const input = object(raw)
  const environment = options.env ?? process.env
  const home = options.home ?? homedir()
  let issue: string | undefined
  const inputs: McpCandidate['inputs'] = []
  const expandHome = (value: unknown) => typeof value === 'string' && value.startsWith('~/') ? join(home, value.slice(2)) : value
  const fieldMap = (value: unknown, kind: 'env' | 'header'): Record<string, unknown> => {
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) issue = 'This configuration needs manual setup.'
    return Object.fromEntries(Object.entries(object(value)).map(([key, value]) => {
      if (typeof value === 'string' && /\$\{|\$[A-Za-z_]/.test(value)) {
        inputs.push({ key: `${kind}:${key}`, label: kind === 'header' ? `${key} header` : `${key} environment variable` })
        return [key, '']
      }
      return [key, value]
    }))
  }
  const config: ObjectValue = input.command !== undefined ? {
    command: expandHome(input.command), args: Array.isArray(input.args) ? input.args.map(expandHome) : input.args ?? [],
    env: fieldMap(input.env, 'env'), ...(input.cwd !== undefined ? { cwd: expandHome(input.cwd) } : {}),
  } : { url: input.url ?? input.serverUrl, headers: fieldMap(input.http_headers ?? input.headers, 'header') }
  const reference = (kind: 'env' | 'header', key: string, variable: unknown, bearer = false) => {
    if (typeof variable !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) { issue = 'An environment reference needs manual setup.'; return }
    const fields = config[kind === 'env' ? 'env' : 'headers'] as ObjectValue
    const value = environment[variable]
    if (value) fields[key] = bearer ? `Bearer ${value}` : value
    else {
      fields[key] = ''
      inputs.push({ key: `${kind}:${key}`, label: bearer ? `${key} header (Bearer token)` : `${key} (${variable})` })
    }
  }
  if ('command' in config) {
    for (const variable of Array.isArray(input.env_vars) ? input.env_vars : []) {
      if (typeof variable === 'string') reference('env', variable, variable)
      else issue = 'An environment reference needs manual setup.'
    }
  } else {
    for (const [key, variable] of Object.entries(object(input.env_http_headers))) reference('header', key, variable)
    if (input.bearer_token_env_var !== undefined) reference('header', 'Authorization', input.bearer_token_env_var, true)
  }
  if (input.enabled === false || input.disabled === true) issue = 'Disabled in the source app. Enable it there and scan again.'
  else if (input.type && !['stdio', 'http', 'streamable-http'].includes(String(input.type))) issue = 'This connection type needs manual setup.'
  else if (input.envFile || input.auth || input.oauth || input.enabled_tools || input.disabled_tools || input.includeTools || input.excludeTools) issue = 'This connection uses app-specific authentication or settings. Use advanced setup.'
  else if (Object.keys(input).some((key) => !SUPPORTED_FIELDS.has(key))) issue = 'This connection uses app-specific settings. Use advanced setup.'
  const executableFields = [config.command, config.url, config.cwd, ...Array.isArray(config.args) ? config.args : []]
  if (executableFields.some((value) => typeof value === 'string' && /\$\{|\$[A-Za-z_]/.test(value))) issue = 'The command or URL uses app-specific variables. Use advanced setup.'
  if ((typeof config.cwd === 'string' && !isAbsolute(config.cwd)) || (typeof config.command === 'string' && /^\.\.?[/\\]/.test(config.command))) issue = 'A relative command or working directory needs an absolute path. Use advanced setup.'
  const parsed = mcpServerConfigSchema.safeParse(config)
  if (!parsed.success || Buffer.byteLength(JSON.stringify(config)) > 100_000 || inputs.length > 64) issue = 'This configuration is unsupported or too large. Use advanced setup.'
  const dedupedInputs = [...new Map(inputs.map((field) => [field.key, { key: field.key.slice(0, 150), label: field.label.slice(0, 180) }])).values()].slice(0, 64)
  // Bind the candidate to its exact source configuration, including unresolved
  // placeholders. Re-reading on connect cannot silently import changed settings.
  const id = createHash('sha256').update(canonical({ input, config, inputs: dedupedInputs, issue })).digest('hex')
  return { candidate: { id, name, sources: [source.name], transport: 'command' in config ? 'stdio' : 'http', inputs: dedupedInputs, ...(issue ? { issue } : {}) }, config: parsed.success ? parsed.data : config }
}

async function scan(options: DiscoveryOptions): Promise<{ entries: Entry[]; warnings: string[] }> {
  const entries = new Map<string, Entry>()
  const warnings: string[] = []
  for (const source of discoverySources(options)) {
    let parsed: ObjectValue
    try { parsed = await readSource(source) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`${source.name}: could not read its MCP configuration.`)
      continue
    }
    const servers = Object.entries(object(parsed[source.root]))
    if (servers.length > 100) warnings.push(`${source.name}: only the first 100 connections were checked.`)
    for (const [name, raw] of servers.slice(0, 100)) {
      if (!name.trim() || name.length > 80) { warnings.push(`${source.name}: a connection has an unsupported name.`); continue }
      let entry: Entry
      try { entry = normalize(name, raw, source, options) }
      catch { warnings.push(`${source.name}: a connection could not be read.`); continue }
      const existing = entries.get(entry.candidate.id)
      if (existing) { if (!existing.candidate.sources.includes(source.name)) existing.candidate.sources.push(source.name) }
      else if (entries.size < 100) entries.set(entry.candidate.id, entry)
      else if (!warnings.includes('Showing the first 100 discovered connections.')) warnings.push('Showing the first 100 discovered connections.')
    }
  }
  return { entries: [...entries.values()], warnings: [...new Set(warnings)].slice(0, 16) }
}

export async function discoverConfiguredMcp(options: DiscoveryOptions = {}): Promise<McpDiscovery> {
  const { entries, warnings } = await scan(options)
  return mcpDiscoverySchema.parse({ candidates: entries.map((entry) => entry.candidate), warnings })
}

export async function resolveConfiguredMcp(id: string, supplied: Record<string, string>, options: DiscoveryOptions = {}): Promise<{ name: string; config: McpServerConfig }> {
  const entry = (await scan(options)).entries.find((entry) => entry.candidate.id === id)
  if (!entry) throw new Error('MCP: This connection changed or was removed. Scan again before connecting.')
  if (entry.candidate.issue) throw new Error(`MCP: ${entry.candidate.issue}`)
  if (Object.keys(supplied).some((key) => !entry.candidate.inputs.some((field) => field.key === key))) throw new Error('MCP: Unexpected credential fields. Scan again.')
  for (const field of entry.candidate.inputs) {
    const value = supplied[field.key]
    if (!value || value.length > 20_000) throw new Error('MCP: Fill in the requested credential fields.')
    const separator = field.key.indexOf(':')
    const record = entry.config[field.key.slice(0, separator) === 'env' ? 'env' : 'headers'] as ObjectValue
    Object.defineProperty(record, field.key.slice(separator + 1), { value, enumerable: true, writable: true, configurable: true })
  }
  const config = mcpServerConfigSchema.safeParse(entry.config)
  if (!config.success || Buffer.byteLength(JSON.stringify(entry.config)) > 100_000) throw new Error('MCP: Check the credential fields and configuration size.')
  return { name: entry.candidate.name, config: config.data }
}
