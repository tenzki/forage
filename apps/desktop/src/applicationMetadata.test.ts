import { describe, expect, it, vi } from 'vitest'
import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'
import { applicationVersion } from './applicationMetadata'
import application from '../package.json'

vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '9.8.7') }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => true) }))
describe('application metadata adapter', () => {
  it('reads the running native build version', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    expect(await applicationVersion()).toBe('9.8.7')
    expect(getVersion).toHaveBeenCalledOnce()
  })
  it('uses explicitly labeled package metadata in development', async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    expect(await applicationVersion()).toBe(`${application.version} (development)`)
  })
})
