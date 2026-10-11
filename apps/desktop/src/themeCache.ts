export const THEME_CACHE_KEY = 'forage.theme.v1'

export function cacheTheme(theme: 'system' | 'light' | 'dark') {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, theme)
  } catch {}
}

export function initializeTheme() {
  let theme = 'system'
  try {
    const cached = window.localStorage.getItem(THEME_CACHE_KEY)
    if (cached === 'system' || cached === 'light' || cached === 'dark') theme = cached
  } catch {}
  const dark = theme === 'system'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset.theme = theme === 'system' ? dark ? 'dark' : 'light' : theme
}
