import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppearance } from './appearance'
import { useSettingsStore } from './store/settingsStore'
import { DEFAULT_DEVICE_PREFERENCES } from './store/settingsMigration'

const dark = new EventTarget() as EventTarget & { matches: boolean }
const motion = new EventTarget() as EventTarget & { matches: boolean }
function Appearance() { useAppearance(); return null }
beforeEach(() => {
  dark.matches = false
  motion.matches = false
  vi.stubGlobal('matchMedia', vi.fn((query: string) => query.includes('color-scheme') ? dark : motion))
  useSettingsStore.setState({ devicePreferences: { ...DEFAULT_DEVICE_PREFERENCES }, isLoaded: true })
  delete document.documentElement.dataset.theme
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('device appearance', () => {
  it('does not apply the default system theme while saved preferences are loading', () => {
    dark.matches = true
    useSettingsStore.setState({ isLoaded: false })
    const add = vi.spyOn(dark, 'addEventListener')
    const view = render(<Appearance />)
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(add).not.toHaveBeenCalled()
    act(() => useSettingsStore.setState({
      isLoaded: true,
      devicePreferences: { ...DEFAULT_DEVICE_PREFERENCES, theme: 'light' },
    }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(add).not.toHaveBeenCalled()
    view.unmount()
  })

  it('keeps the current appearance until hydration and then follows the saved System preference', () => {
    document.documentElement.dataset.theme = 'light'
    dark.matches = true
    useSettingsStore.setState({ isLoaded: false })
    const view = render(<Appearance />)
    expect(document.documentElement.dataset.theme).toBe('light')
    act(() => useSettingsStore.setState({ isLoaded: true }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    act(() => { dark.matches = false; dark.dispatchEvent(new Event('change')) })
    expect(document.documentElement.dataset.theme).toBe('light')
    view.unmount()
  })

  it('follows OS changes only for System and applies typography without document changes', () => {
    const agents = useSettingsStore.getState().agents
    const view = render(<Appearance />)
    expect(document.documentElement.dataset.theme).toBe('light')
    act(() => { dark.matches = true; dark.dispatchEvent(new Event('change')) })
    expect(document.documentElement.dataset.theme).toBe('dark')
    act(() => useSettingsStore.setState({ devicePreferences: { ...DEFAULT_DEVICE_PREFERENCES, theme: 'light', outlineFont: 'serif', outlineFontSize: 20 } }))
    act(() => { dark.matches = false; dark.dispatchEvent(new Event('change')); dark.matches = true; dark.dispatchEvent(new Event('change')) })
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.getPropertyValue('--outline-font-size')).toBe('20px')
    expect(document.documentElement.style.getPropertyValue('--outline-font')).toContain('Georgia')
    expect(useSettingsStore.getState().agents).toBe(agents)
    view.unmount()
  })
  it('honors the motion preference and removes listeners on unmount', () => {
    const remove = vi.spyOn(motion, 'removeEventListener')
    const view = render(<Appearance />)
    act(() => { motion.matches = true; motion.dispatchEvent(new Event('change')) })
    expect(document.documentElement.dataset.reduceMotion).toBe('true')
    act(() => useSettingsStore.setState({ devicePreferences: { ...DEFAULT_DEVICE_PREFERENCES, followSystemMotion: false } }))
    expect(document.documentElement.dataset.reduceMotion).toBe('false')
    view.unmount()
    expect(remove).toHaveBeenCalled()
  })
})
