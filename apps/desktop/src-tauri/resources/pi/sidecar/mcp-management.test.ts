import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('MCP discovery subprocess', () => {
  const entries = ['mcp-management.ts', ...(existsSync(fileURLToPath(new URL('./dist/mcp-management.mjs', import.meta.url))) ? ['dist/mcp-management.mjs'] : [])]
  it.each(entries)('%s scans configuration without executing servers and resolves only unchanged candidates', async (relativeEntry) => {
    const home = await mkdtemp(join(tmpdir(), 'forage-mcp-scan-'))
    const codexHome = join(home, '.codex')
    const entry = fileURLToPath(new URL(relativeEntry, import.meta.url))
    await mkdir(codexHome)
    await writeFile(join(codexHome, 'config.toml'), '[mcp_servers.pen]\ncommand = "/not/a/real/executable"\nenv = { TOKEN = "private-config-secret" }\n')
    const request = async (payload: unknown) => {
      const child = spawn(process.execPath, entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: join(home, '.claude'), APPDATA: home, XDG_CONFIG_HOME: home },
      })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
      let stdout = ''
      child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value })
      const exit = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject) })
      child.stdin.write(`${JSON.stringify(payload)}\n`)
      try { await exit; return stdout }
      finally { clearTimeout(timeout); child.kill() }
    }
    try {
      const scanned = await request({ action: 'scan' })
      expect(scanned).not.toContain('private-config-secret')
      expect(scanned).not.toContain('/not/a/real/executable')
      const candidate = JSON.parse(scanned).discovery.candidates[0]
      expect(candidate).toMatchObject({ name: 'pen', sources: ['Codex'], inputs: [] })
      const resolved = JSON.parse(await request({ action: 'resolve', id: candidate.id, values: {} }))
      expect(resolved).toMatchObject({ ok: true, configuration: { config: { command: '/not/a/real/executable', env: { TOKEN: 'private-config-secret' } } } })
      await writeFile(join(codexHome, 'config.toml'), '[mcp_servers.pen]\ncommand = "changed"\n')
      expect(JSON.parse(await request({ action: 'resolve', id: candidate.id, values: {} }))).toMatchObject({ ok: false, error: expect.stringContaining('changed or was removed') })
    } finally { await rm(home, { recursive: true, force: true }) }
  })
  it.each(entries)('%s accepts configuration over stdin and emits only sanitized inventory', async (relativeEntry) => {
    const entry = fileURLToPath(new URL(relativeEntry, import.meta.url))
    const fixture = fileURLToPath(new URL('../../../../../../packages/mcp-host/tests/fixture.mjs', import.meta.url))
    const child = spawn(process.execPath, entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry], { stdio: ['pipe', 'pipe', 'pipe'] })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value })
    child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value })
    const exit = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
    child.stdin.write(`${JSON.stringify({ id: 'fixture', name: 'Fixture', config: {
      command: process.execPath, args: [fixture], env: { MCP_FIXTURE_STDIO: '1', SECRET: 'do-not-persist' },
    } })}\n`)
    try {
      expect(await exit).toBe(0)
      const response = JSON.parse(stdout)
      expect(response).toMatchObject({ ok: true, connection: { id: 'fixture', environment: 'local' } })
      expect(response.connection.tools).toHaveLength(3)
      expect(`${stdout}${stderr}`).not.toContain('do-not-persist')
      expect(stdout).not.toContain('"command"')
    } finally { clearTimeout(timeout); child.kill() }
  })
})
