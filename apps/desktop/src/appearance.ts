import { useLayoutEffect } from 'react'
import { useSettingsStore } from './store/settingsStore'
import type { DevicePreferences } from './store/settingsMigration'

export const outlineFonts = {
  default: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  system: 'system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'var(--font-mono)',
}

export function applyAppearance(preferences: DevicePreferences, dark: boolean, reducedMotion: boolean) {
  const root = document.documentElement
  root.dataset.theme = preferences.theme === 'system' ? dark ? 'dark' : 'light' : preferences.theme
  root.dataset.reduceMotion = String(preferences.followSystemMotion && reducedMotion)
  root.style.setProperty('--outline-font', outlineFonts[preferences.outlineFont])
  root.style.setProperty('--outline-font-size', `${preferences.outlineFontSize === 'default' ? 15 : preferences.outlineFontSize}px`)
}

export function useAppearance() {
  const preferences = useSettingsStore((state) => state.devicePreferences)
  const isLoaded = useSettingsStore((state) => state.isLoaded)
  useLayoutEffect(() => {
    if (!isLoaded) return
    if (typeof window.matchMedia !== 'function') {
      applyAppearance(preferences, false, false)
      return
    }
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => applyAppearance(preferences, dark.matches, motion.matches)
    apply()
    if (preferences.theme === 'system') dark.addEventListener('change', apply)
    if (preferences.followSystemMotion) motion.addEventListener('change', apply)
    return () => { dark.removeEventListener('change', apply); motion.removeEventListener('change', apply) }
  }, [preferences, isLoaded])
}
