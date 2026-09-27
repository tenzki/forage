// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Start `src/main.ts` as if the running Node.js reported `version`, without any server configuration. */
function start(version?: string) {
  const stub = version ? `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });` : ''
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `${stub} await import('./src/main.ts')`], {
    cwd: serverRoot, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH ?? '' },
  })
}

describe('server startup', () => {
  it('exits before loading the server on a Node.js older than the Pi SDK requires', () => {
    const result = start('22.18.0')
    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toBe('Forage server requires Node.js 22.19.0 or newer to run agents; this is Node.js 22.18.0.')
  })

  it('goes on to load the server configuration on a supported Node.js', () => {
    const result = start()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/DATABASE_URL/)
    expect(result.stderr).not.toContain('requires Node.js')
  })
})
