// Shipped React controls/CSS inside an isolated Tauri App; no GUI automation.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'darwin', 'Native onboarding checks require macOS')
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const native = join(desktop, 'src-tauri')
const config = JSON.parse(readFileSync(join(native, 'tauri.workspace-verify.conf.json'), 'utf8'))
config.build.devUrl = null
for (const [command, args, cwd] of [
  ['pnpm', ['--filter', 'forage-sidecar', 'build'], resolve(desktop, '../..')],
  ['pnpm', ['build:onboarding-verify'], desktop],
  ['cargo', ['build', '--example', 'onboarding', '--offline'], native],
]) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...(command === 'cargo' ? { TAURI_CONFIG: JSON.stringify(config) } : {}) } })
  assert.equal(result.status, 0, `${command} build failed`)
}
// Refresh resources just built, even when Cargo reuses its build-script cache.
const sync = spawnSync(process.execPath, [join(desktop, 'scripts/sync-dev-sidecar.mjs')], { stdio: 'inherit' })
assert.equal(sync.status, 0)
// Cargo examples use target/debug/resources as their resource directory.
cpSync(join(native, 'resources/pi/sidecar/dist'), join(native, 'target/debug/resources/resources/pi/sidecar/dist'), { recursive: true })
const directory = mkdtempSync(join(tmpdir(), 'forage-onboarding-'))
const runId = randomUUID()
const identifier = `com.forage.onboarding-verification.${runId}`
try {
  const reports = []
  for (const mode of ['flow', 'restart', 'active', 'completed']) {
    const reportPath = join(directory, `${mode}.json`)
    const result = spawnSync(join(native, 'target/debug/examples/onboarding'), [], {
      cwd: resolve(desktop, '../..'), stdio: 'inherit', timeout: 200_000,
      env: { ...process.env, FORAGE_ONBOARDING_DATA: directory, FORAGE_ONBOARDING_RUN_ID: runId, FORAGE_ONBOARDING_REPORT: reportPath, FORAGE_ONBOARDING_MODE: mode, FORAGE_CONFIGURATION_ROOT: join(directory, 'extensions') },
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `Native onboarding ${mode} failed`)
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.equal(report.passed, true)
    reports.push(report)
  }
  assert.equal(reports[0].persistence.progress.status, 'paused')
  assert.equal(reports[1].persistence.progress.status, 'in-progress')
  assert.equal(reports[2].persistence.progress.status, 'completed')
  assert.equal(reports[3].ready.status, 'completed')
  assert.ok(reports[0].checks.length >= 25)
  const report = { passed: true, platform: process.platform, timestamp: new Date().toISOString(), flow: reports[0], restart: reports[1], activeResume: reports[2], completedRestart: reports[3] }
  if (process.env.FORAGE_ONBOARDING_REPORT) writeFileSync(process.env.FORAGE_ONBOARDING_REPORT, `${JSON.stringify(report, null, 2)}\n`)
  console.log('ONBOARDING_NATIVE_PASSED (eleven screens, narrow layout, durable pause/resume/completion)')
} finally {
  rmSync(directory, { recursive: true, force: true })
  rmSync(join(homedir(), 'Library/Application Support', identifier), { recursive: true, force: true })
}
