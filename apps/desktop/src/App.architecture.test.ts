import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('App application boundary', () => {
  it('delegates persistence and synchronization orchestration to OutlineSession', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/desktop/src/App.tsx'), 'utf8')

    expect(source).toContain('new OutlineSession')
    expect(source).not.toContain('new NativeEventRepository')
    expect(source).not.toContain('new DesktopSyncEngine')
    expect(source).not.toContain('.loadReplayInput(')
    expect(source).not.toContain('.saveCheckpoint(')
  })
})
