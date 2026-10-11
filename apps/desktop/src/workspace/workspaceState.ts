export type PaneLocation = { kind: 'outline'; nodeId: string | null }
  | { kind: 'web'; href: string; sourceNodeId?: string }
export interface PaneVisit { location: PaneLocation; scrollTop: number }
export interface WorkspacePane {
  id: string
  width: number
  current: PaneVisit
  back: PaneVisit[]
  forward: PaneVisit[]
}
export interface WorkspaceState {
  panes: WorkspacePane[]
  activePaneId: string
  lastOutlinePaneId: string
}
export type WorkspaceAction =
  | { type: 'activate'; id: string }
  | { type: 'open'; sourceId: string; id: string; location: PaneLocation; scrollTop?: number }
  | { type: 'split'; sourceId: string; id: string }
  | { type: 'close'; id: string }
  | { type: 'navigate'; id: string; location: PaneLocation }
  | { type: 'back' | 'forward'; id: string }
  | { type: 'scroll'; id: string; scrollTop: number }
  | { type: 'width'; id: string; width: number }
  | { type: 'resizePair'; id: string; delta: number; minimum: number; leftWidth?: number; rightWidth?: number }

export const HOME: PaneLocation = { kind: 'outline', nodeId: null }
export function initialWorkspace(id = 'primary'): WorkspaceState {
  return { panes: [{ id, width: 480, current: { location: HOME, scrollTop: 0 }, back: [], forward: [] }],
    activePaneId: id, lastOutlinePaneId: id }
}
export function outlineTarget(state: WorkspaceState): WorkspacePane {
  const active = state.panes.find(pane => pane.id === state.activePaneId)!
  return active.current.location.kind === 'outline' ? active
    : state.panes.find(pane => pane.id === state.lastOutlinePaneId && pane.current.location.kind === 'outline')
      ?? state.panes.find(pane => pane.current.location.kind === 'outline')!
}
export function canClosePane(state: WorkspaceState, id: string): boolean {
  const pane = state.panes.find(pane => pane.id === id)
  return Boolean(pane && (pane.current.location.kind === 'web'
    || state.panes.filter(pane => pane.current.location.kind === 'outline').length > 1))
}
function sameLocation(a: PaneLocation, b: PaneLocation): boolean {
  return a.kind === b.kind && (a.kind === 'outline'
    ? a.nodeId === (b as Extract<PaneLocation, { kind: 'outline' }>).nodeId
    : a.href === (b as Extract<PaneLocation, { kind: 'web' }>).href)
}
function activate(state: WorkspaceState, id: string): WorkspaceState {
  const pane = state.panes.find(pane => pane.id === id)
  if (!pane) return state
  return { ...state, activePaneId: id,
    lastOutlinePaneId: pane.current.location.kind === 'outline' ? id : state.lastOutlinePaneId }
}
export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  if (action.type === 'activate') return state.activePaneId === action.id ? state : activate(state, action.id)
  if (action.type === 'open' || action.type === 'split') {
    const index = state.panes.findIndex(pane => pane.id === action.sourceId)
    if (index < 0 || state.panes.some(pane => pane.id === action.id)) return state
    const source = state.panes[index]
    const current = action.type === 'split' ? { ...source.current } : { location: action.location, scrollTop: action.scrollTop ?? 0 }
    const pane: WorkspacePane = { id: action.id, width: source.width, current, back: [], forward: [] }
    return activate({ ...state, panes: [...state.panes.slice(0, index + 1), pane, ...state.panes.slice(index + 1)] }, pane.id)
  }
  const index = state.panes.findIndex(pane => pane.id === action.id)
  if (index < 0) return state
  if (action.type === 'close') {
    if (!canClosePane(state, action.id)) return state
    const panes = state.panes.filter(pane => pane.id !== action.id)
    const neighbor = panes[Math.max(0, index - 1)]
    const next = { ...state, panes,
      lastOutlinePaneId: state.lastOutlinePaneId === action.id
        ? [...panes.slice(0, index)].reverse().find(pane => pane.current.location.kind === 'outline')?.id
          ?? panes.find(pane => pane.current.location.kind === 'outline')!.id : state.lastOutlinePaneId }
    return action.id === state.activePaneId ? activate(next, neighbor.id) : next
  }
  const pane = state.panes[index]
  if (action.type === 'resizePair') {
    const right = state.panes[index + 1]
    if (!right || !Number.isFinite(action.delta)) return state
    const minimum = Math.min(360, Math.max(1, action.minimum))
    const leftWidth = action.leftWidth ?? pane.width
    const rightWidth = action.rightWidth ?? right.width
    const delta = Math.max(minimum - leftWidth, Math.min(rightWidth - minimum, action.delta))
    return { ...state, panes: state.panes.map((item, i) => i === index ? { ...item, width: leftWidth + delta } : i === index + 1 ? { ...item, width: rightWidth - delta } : item) }
  }
  let updated = pane
  if (action.type === 'scroll') updated = { ...pane, current: { ...pane.current, scrollTop: Math.max(0, action.scrollTop) } }
  if (action.type === 'width') updated = { ...pane, width: Math.max(360, action.width) }
  if (action.type === 'navigate') {
    // Locations never convert a pane's kind; opening the other kind creates a new pane.
    if (action.location.kind !== pane.current.location.kind || sameLocation(pane.current.location, action.location)) return state
    updated = { ...pane, current: { location: action.location, scrollTop: 0 }, back: [...pane.back, pane.current], forward: [] }
  }
  if (action.type === 'back' || action.type === 'forward') {
    const stack = pane[action.type]
    if (!stack.length) return state
    updated = action.type === 'back'
      ? { ...pane, current: stack[stack.length - 1], back: stack.slice(0, -1), forward: [...pane.forward, pane.current] }
      : { ...pane, current: stack[stack.length - 1], forward: stack.slice(0, -1), back: [...pane.back, pane.current] }
  }
  return { ...state, panes: state.panes.map((pane, i) => i === index ? updated : pane) }
}
