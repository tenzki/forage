import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

export const settingsSections = [
  { id: 'general', label: 'General' }, { id: 'connection', label: 'Connection' },
  { id: 'agents', label: 'Agents' }, { id: 'extensions', label: 'Extensions' }, { id: 'mcp', label: 'MCP servers' },
] as const
export type SettingsSection = typeof settingsSections[number]['id']
export type SettingsPage = 'diagnostics' | 'provider' | 'agent' | 'skill' | 'extension' | 'review' | 'setup'
export interface SettingsRoute { section: SettingsSection; page?: SettingsPage; entityId?: string }
interface Navigation {
  route: SettingsRoute
  select: (section: SettingsSection) => void
  open: (section: SettingsSection, page: SettingsPage, returnAction?: () => void, entityId?: string) => void
  back: () => void
  requestLeave: (action: () => void) => void
  registerGuard: (guard: (action: () => void) => void) => () => void
  clearGuard: () => void
  restore: (route: SettingsRoute, returnAction?: () => void) => void
}
export const SettingsNavigationContext = createContext<Navigation | null>(null)
export const useSettingsNavigation = () => useContext(SettingsNavigationContext)

export function useSettingsRouter() {
  const [route, setRoute] = useState<SettingsRoute>({ section: 'general' })
  const origin = useRef<HTMLElement | null>(null)
  const originLabel = useRef<string | null>(null)
  const originId = useRef<string | null>(null)
  const cleanup = useRef<(() => void) | undefined>(undefined)
  const returning = useRef(false)
  const guard = useRef<((action: () => void) => void) | null>(null)
  const requestLeave = (action: () => void) => guard.current ? guard.current(action) : action()
  useEffect(() => {
    if (!returning.current) return
    returning.current = false
    const replacement = originId.current ? document.getElementById(originId.current) : Array.from(document.querySelectorAll<HTMLElement>('.settings-content button')).find((button) => !button.closest('[hidden]') && (button.getAttribute('aria-label') ?? button.textContent) === originLabel.current)
    const target = origin.current?.isConnected ? origin.current : replacement ?? document.querySelector<HTMLElement>(`[data-settings-section="${route.section}"]`)
    if (target?.matches(':disabled')) document.querySelector<HTMLElement>(`[data-settings-section="${route.section}"]`)?.focus()
    else target?.focus()
  }, [route])
  const back = () => requestLeave(() => {
    const action = cleanup.current
    cleanup.current = undefined
    action?.()
    returning.current = true
    setRoute({ section: route.section })
  })
  return {
    route, back, requestLeave,
    clearGuard: () => { guard.current = null },
    restore: (nextRoute: SettingsRoute, returnAction?: () => void) => requestLeave(() => { cleanup.current = returnAction; returning.current = true; setRoute(nextRoute) }),
    registerGuard: (handler: (action: () => void) => void) => { guard.current = handler; return () => { if (guard.current === handler) guard.current = null } },
    select: (section: SettingsSection) => requestLeave(() => { const action = cleanup.current; cleanup.current = undefined; action?.(); setRoute({ section }) }),
    open: (section: SettingsSection, page: SettingsPage, returnAction?: () => void, entityId?: string) => requestLeave(() => {
      origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      originLabel.current = origin.current?.getAttribute('aria-label') ?? origin.current?.textContent ?? null
      originId.current = origin.current?.id || null
      cleanup.current = returnAction
      setRoute({ section, page, ...(entityId ? { entityId } : {}) })
    }),
  }
}

export function SettingsNavigationProvider({ value, children }: { value: Navigation; children: ReactNode }) {
  return <SettingsNavigationContext.Provider value={value}>{children}</SettingsNavigationContext.Provider>
}
