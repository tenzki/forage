import { describe, expect, it, vi, beforeEach } from 'vitest'
import { migrateLegacyIdentity } from './legacyMigration'

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn<(path: string) => Promise<boolean>>(async () => false),
  mkdir: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  copyFile: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/plugin-fs', () => fsMocks)

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home/test',
  appDataDir: async () => '/home/test/appdata',
  join: async (...parts: string[]) => parts.join('/'),
}))

const OLD_OUTLINE_DIR = '/home/test/Library/Mobile Documents/com~apple~CloudDocs/AIChat'
const NEW_OUTLINE_DIR = '/home/test/Library/Mobile Documents/com~apple~CloudDocs/Forage'
const OLD_SETTINGS = '/home/test/Library/Application Support/com.ai-chat.app/settings.json'
const NEW_SETTINGS = '/home/test/appdata/settings.json'

function existsAt(paths: string[]) {
  fsMocks.exists.mockImplementation(async (path: string) => paths.includes(path))
}

describe('legacy ai-chat → forage migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renames the iCloud folder and copies settings when only old locations exist', async () => {
    existsAt([OLD_OUTLINE_DIR, OLD_SETTINGS])
    await migrateLegacyIdentity()
    expect(fsMocks.rename).toHaveBeenCalledWith(OLD_OUTLINE_DIR, NEW_OUTLINE_DIR)
    expect(fsMocks.mkdir).toHaveBeenCalledWith('/home/test/appdata', { recursive: true })
    expect(fsMocks.copyFile).toHaveBeenCalledWith(OLD_SETTINGS, NEW_SETTINGS)
  })

  it('is a no-op when the new locations already exist', async () => {
    existsAt([NEW_OUTLINE_DIR, NEW_SETTINGS, OLD_OUTLINE_DIR, OLD_SETTINGS])
    await migrateLegacyIdentity()
    expect(fsMocks.rename).not.toHaveBeenCalled()
    expect(fsMocks.copyFile).not.toHaveBeenCalled()
  })

  it('does nothing on a fresh install', async () => {
    existsAt([])
    await migrateLegacyIdentity()
    expect(fsMocks.rename).not.toHaveBeenCalled()
    expect(fsMocks.copyFile).not.toHaveBeenCalled()
  })

  it('continues with the settings migration when the outline folder move fails', async () => {
    existsAt([OLD_OUTLINE_DIR, OLD_SETTINGS])
    fsMocks.rename.mockRejectedValueOnce(new Error('fs scope denied'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await migrateLegacyIdentity()
    expect(fsMocks.copyFile).toHaveBeenCalledWith(OLD_SETTINGS, NEW_SETTINGS)
    errorSpy.mockRestore()
  })
})
