// Real AppKit events and shipped CSS in a self-verifying WKWebView fixture.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'darwin', 'Native shortcut verification requires macOS')
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(desktop, '../..')
const native = join(desktop, 'src-tauri')
const build = spawnSync('cargo', ['build', '--example', 'pane_shortcuts', '--offline'], { cwd: native, stdio: 'inherit' })
assert.equal(build.status, 0, 'Native probe build failed; build the desktop/sidecar first')
const directory = mkdtempSync(join(tmpdir(), 'forage-pane-shortcuts-'))
try {
  const reportPath = join(directory, 'report.json')
  const result = spawnSync(join(native, 'target/debug/examples/pane_shortcuts'), [], {
    cwd: root, env: { ...process.env, FORAGE_SHORTCUT_REPORT: reportPath }, encoding: 'utf8', timeout: 45_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `Native verification failed: ${result.stdout}\n${result.stderr}`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(report.passed, true)
  assert.equal(report.checks.length, 16)
  if (process.env.FORAGE_SHORTCUT_REPORT) writeFileSync(process.env.FORAGE_SHORTCUT_REPORT, `${JSON.stringify(report, null, 2)}\n`)
  console.log('PANE_SHORTCUTS_PASSED (10 owned shortcut deliveries, form/repeat precedence, 4 production-CSS layouts)')
} finally { rmSync(directory, { recursive: true, force: true }) }
