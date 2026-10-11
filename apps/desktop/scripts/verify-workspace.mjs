// Actual App in an isolated Tauri process. Run in a Herdr pane when HERDR_ENV=1.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'darwin', 'Native workspace verification requires macOS')
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(desktop, '../..'),
  native = join(desktop, 'src-tauri')
for (const [command, args, cwd] of [
  ['pnpm', ['build:workspace-verify'], desktop],
  ['cargo', ['build', '--example', 'workspace', '--offline'], native],
]) {
  const config = JSON.parse(readFileSync(join(native, 'tauri.workspace-verify.conf.json'), 'utf8'))
  config.build.devUrl = null
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(command === 'cargo' ? { TAURI_CONFIG: JSON.stringify(config) } : {}),
    },
  })
  assert.equal(result.status, 0, `${command} verification build failed`)
}
const directory = mkdtempSync(join(tmpdir(), 'forage-workspace-'))
const runId = randomUUID()
const identifier = `com.forage.workspace-verification.${runId}`
const layoutOnly = process.env.FORAGE_WORKSPACE_LAYOUT_ONLY === '1'
try {
  const reports = []
  for (const restart of layoutOnly ? [false] : [false, true]) {
    const reportPath = join(directory, restart ? 'restart.json' : 'flow.json')
    const result = spawnSync(join(native, 'target/debug/examples/workspace'), [], {
      cwd: root,
      stdio: 'inherit',
      timeout: 200_000,
      env: {
        ...process.env,
        FORAGE_WORKSPACE_DATA: directory,
        FORAGE_WORKSPACE_RUN_ID: runId,
        FORAGE_WORKSPACE_REPORT: reportPath,
        ...(restart ? { FORAGE_WORKSPACE_RESTART: '1' } : {}),
      },
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, 'Native App verification failed (see probe output above)')
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.equal(report.passed, true)
    reports.push(report)
  }
  const report = {
    passed: true,
    platform: process.platform,
    timestamp: new Date().toISOString(),
    flow: reports[0],
    ...(layoutOnly ? { layoutOnly: true } : { restart: reports[1] }),
  }
  if (layoutOnly) {
    const layout = report.flow.checks.find(
      (check) => check.stage === 'open-right-source-visibility',
    ).data
    assert.ok(layout.outline.sourcePainted && layout.web.sourcePainted)
    assert.ok(layout.centered.left > 0)
    assert.equal(layout.centered.left, layout.centered.right)
    assert.equal(layout.centeredDrag.edgeMovement, 30)
    assert.equal(layout.overflowDrag.edgeMovement, 30)
    assert.equal(layout.overflow.left, 0)
    assert.equal(layout.singleWidth, 280)
  } else {
    assert.deepEqual(
      report.flow.performance.cases.map((entry) => entry.panes),
      [1, 3, 10],
    )
    for (const entry of report.flow.performance.cases) {
      assert.ok(entry.bullets >= 1000)
      assert.ok(
        entry.editToFrameMedianMs < 250,
        'Material pane latency regression (median >= 250ms)',
      )
      assert.ok(entry.editToFrameP95Ms < 500, 'Material pane latency regression (p95 >= 500ms)')
    }
    assert.equal(report.flow.performance.destroyedEditors, 20)
    assert.equal(report.flow.performance.objectUrls, 0)
    assert.equal(report.flow.nativeWebviews, 1)
    assert.equal(report.restart.persisted.count, report.flow.durable.count)
  }
  if (process.env.FORAGE_WORKSPACE_REPORT)
    writeFileSync(process.env.FORAGE_WORKSPACE_REPORT, `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    layoutOnly
      ? 'WORKSPACE_LAYOUT_PASSED (native App layout and resize regression)'
      : 'WORKSPACE_NATIVE_PASSED (integrated App, SQLite restart and 1/3/10-pane performance)',
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
  // Only the fresh UUID-scoped fixture plugin-store directory is removed.
  rmSync(join(homedir(), 'Library/Application Support', identifier), {
    recursive: true,
    force: true,
  })
}
