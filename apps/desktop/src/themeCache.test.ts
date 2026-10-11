import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cacheTheme, initializeTheme, THEME_CACHE_KEY } from './themeCache'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    get length() { return values.size },
  })
  delete document.documentElement.dataset.theme
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('startup theme cache', () => {
  it.each(['light', 'dark'] as const)('applies cached %s without consulting system appearance', (theme) => {
    cacheTheme(theme)
    initializeTheme()
    expect(document.documentElement.dataset.theme).toBe(theme)
    expect(window.matchMedia).not.toHaveBeenCalled()
    expect(window.localStorage.length).toBe(1)
    expect(window.localStorage.getItem(THEME_CACHE_KEY)).toBe(theme)
  })

  it('resolves System against the current OS rather than caching its previous resolved color', () => {
    cacheTheme('system')
    initializeTheme()
    expect(document.documentElement.dataset.theme).toBe('dark')
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    initializeTheme()
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it.each([null, 'invalid', '{"theme":"light","token":"secret"}'])('ignores missing or malformed cache: %s', (cached) => {
    if (cached !== null) window.localStorage.setItem(THEME_CACHE_KEY, cached)
    initializeTheme()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('tolerates unavailable storage and missing media query support', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    vi.stubGlobal('matchMedia', undefined)
    expect(() => cacheTheme('dark')).not.toThrow()
    expect(() => initializeTheme()).not.toThrow()
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
