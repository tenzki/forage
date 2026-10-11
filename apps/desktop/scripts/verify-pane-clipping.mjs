// Real Tauri/AppKit/WebKit integration test; no desktop automation permissions.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  throw new Error('The native pane clipping integration test requires macOS')
}
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const native = join(desktop, 'src-tauri')
const build = spawnSync('cargo', ['build', '--example', 'pane_clipping', '--offline'], {
  cwd: native, stdio: 'inherit',
})
assert.equal(build.status, 0, 'Native probe build failed (build forage-sidecar first)')
const executable = join(native, 'target', 'debug', 'examples', 'pane_clipping')
const reportDirectory = mkdtempSync(join(tmpdir(), 'forage-pane-clipping-'))
try {
  for (const [name, fault, expectedError] of [
    ['normal', '', null],
    ['disabled-clipping', 'no-clipping', 'Native ancestor does not clip'],
    ['page-shrunk-to-sliver', 'reflow', 'Native page shrank to its visible sliver'],
  ]) {
    const reportPath = join(reportDirectory, `${name}.json`)
    const env = { ...process.env, FORAGE_PANE_PROBE_REPORT: reportPath }
    delete env.FORAGE_PANE_PROBE_FAULT
    if (fault) env.FORAGE_PANE_PROBE_FAULT = fault
    const result = spawnSync(executable, ['--verify'], { env, encoding: 'utf8', timeout: 40_000 })
    assert.ifError(result.error)
    assert.equal(result.signal, null, `${name}: probe crashed or timed out: ${result.stderr}`)
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    if (expectedError) {
      assert.equal(result.status, 1, `${name}: negative control did not exit with failure`)
      assert.equal(report.passed, false)
      assert.equal(report.error, expectedError)
    } else {
      assert.equal(result.status, 0, `Native verification failed: ${result.stdout}\n${result.stderr}`)
      assert.equal(report.passed, true)
      assert.equal(report.checks.length, 6)
      // Stable evidence artifact for the successful native run; negatives are
      // checked here and do not overwrite the successful run's report.
      if (process.env.FORAGE_PANE_PROBE_REPORT) {
        writeFileSync(process.env.FORAGE_PANE_PROBE_REPORT, `${JSON.stringify(report, null, 2)}\n`)
      }
    }
    console.log(`PASS ${name}${expectedError ? ` (detected: ${expectedError})` : ' (6 native integration stages)'}`)
  }
  console.log('PANE_CLIPPING_INTEGRATION_PASSED')
} finally {
  rmSync(reportDirectory, { recursive: true, force: true })
}
