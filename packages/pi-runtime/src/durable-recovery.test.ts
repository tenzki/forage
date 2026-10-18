import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const fixture = fileURLToPath(new URL('./durable-process.fixture.ts', import.meta.url))

async function child(directory: string, scenario: string, phase: 'crash' | 'recover'): Promise<string> {
  return new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, ['--import', 'tsx', fixture, directory, scenario, phase], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; let stderr = ''; let killed = false
    const timeout = setTimeout(() => { process_.kill('SIGKILL'); reject(new Error(`Fixture timed out: ${stderr}`)) }, 15_000)
    process_.stderr.on('data', (data) => { stderr += data })
    process_.stdout.on('data', (data) => {
      output += data
      if (phase === 'crash' && !killed && output.includes('checkpoint\n')) { killed = true; process_.kill(scenario === 'suspend' ? 'SIGTERM' : 'SIGKILL') }
    })
    process_.on('error', reject)
    process_.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0 && !killed) reject(new Error(`Fixture exited ${code}: ${stderr}`))
      else resolve(output)
    })
  })
}

describe('recovery after forced process death', () => {
  it.each(['completed', 'safe', 'unsafe', 'images', 'budget', 'suspend'])('recovers %s tool execution using its replay policy', async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), 'forage-durable-crash-')); directories.push(directory)
    await child(directory, scenario, 'crash')
    const recovered = JSON.parse((await child(directory, scenario, 'recover')).trim())
    if (scenario === 'budget') expect(recovered).toEqual({ error: 'tool_round_limit' })
    else if (scenario === 'images') expect(recovered.outline.nodes).toEqual([{ type: 'image', image: { src: 'data:image/png;base64,cached-image', alt: 'Saved image' } }])
    else expect(recovered).toMatchObject({ type: 'outline', outline: { nodes: [{ text: 'Recovered.' }] } })
    expect(readFileSync(join(directory, 'hooks'), 'utf8').trim().split('\n')).toEqual(['start', 'end'])
    const effects = readFileSync(join(directory, 'effects'), 'utf8').trim().split('\n')
    expect(effects).toHaveLength(scenario === 'safe' || scenario === 'budget' ? 2 : 1)
    if (scenario === 'safe' || scenario === 'completed' || scenario === 'suspend') expect(recovered.outline.sources).toEqual([{ url: 'https://example.com/evidence', label: 'Evidence' }])
  }, 30_000)
})
