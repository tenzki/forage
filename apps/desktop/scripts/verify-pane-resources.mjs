// Real production registry/WKWebView checks; run in a Herdr pane when HERDR_ENV=1.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
assert.equal(process.platform, 'darwin', 'Native Page verification requires macOS')
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(desktop, '../..'), native = join(desktop, 'src-tauri')
const build = spawnSync('cargo', ['build', '--example', 'pane_resources', '--offline'], { cwd: native, stdio: 'inherit' })
assert.equal(build.status, 0, 'Native resource probe build failed')
const directory = mkdtempSync(join(tmpdir(), 'forage-pane-resources-'))
try {
  const reportPath = join(directory, 'report.json')
  const result = spawnSync(join(native, 'target/debug/examples/pane_resources'), [], {
    cwd: root, env: { ...process.env, FORAGE_RESOURCE_REPORT: reportPath }, encoding: 'utf8', timeout: 55_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `Native verification failed: ${result.stdout}\n${result.stderr}`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(report.passed, true)
  assert.ok(report.checks.length >= 13)
  if (process.env.FORAGE_RESOURCE_REPORT) writeFileSync(process.env.FORAGE_RESOURCE_REPORT, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`PANE_RESOURCES_PASSED (${report.checks.length} production registry, clipping, browsing, isolation and cleanup checks)`)
} finally { rmSync(directory, { recursive: true, force: true }) }
