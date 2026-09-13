import { invoke } from '@tauri-apps/api/core'

export const SERVER_PROVISIONING_STEPS = [
  'connection',
  'outline',
  'synchronization',
  'configuration',
  'mirror',
  'compute',
] as const

export type ServerProvisioningStep = typeof SERVER_PROVISIONING_STEPS[number]

export interface ServerProvisioningState {
  version: 1
  instanceId: string
  outlineId: string
  completed: Partial<Record<ServerProvisioningStep, string>>
  computeSkipped: boolean
}

export function parseServerProvisioningState(value: unknown): ServerProvisioningState | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ServerProvisioningState>
  if (candidate.version !== 1 || typeof candidate.instanceId !== 'string'
    || typeof candidate.outlineId !== 'string' || !candidate.completed
    || typeof candidate.completed !== 'object' || typeof candidate.computeSkipped !== 'boolean') return null
  const completed = Object.fromEntries(Object.entries(candidate.completed).filter(
    ([step, timestamp]) => SERVER_PROVISIONING_STEPS.includes(step as ServerProvisioningStep)
      && typeof timestamp === 'string',
  )) as ServerProvisioningState['completed']
  return { version: 1, instanceId: candidate.instanceId, outlineId: candidate.outlineId, completed, computeSkipped: candidate.computeSkipped }
}

export function firstIncompleteProvisioningStep(state: ServerProvisioningState): ServerProvisioningStep | null {
  return SERVER_PROVISIONING_STEPS.find((step) => step === 'compute'
    ? !state.completed.compute && !state.computeSkipped
    : !state.completed[step]) ?? null
}

export class NativeServerProvisioningStore {
  async load(): Promise<ServerProvisioningState | null> {
    return parseServerProvisioningState(await invoke<unknown | null>('server_provisioning_state'))
  }

  async save(state: ServerProvisioningState): Promise<void> {
    await invoke('server_set_provisioning_state', { progress: state })
  }

  async start(instanceId: string, outlineId: string): Promise<ServerProvisioningState> {
    const existing = await this.load()
    if (existing?.instanceId === instanceId && existing.outlineId === outlineId) return existing
    const state: ServerProvisioningState = {
      version: 1, instanceId, outlineId, completed: {}, computeSkipped: false,
    }
    await this.save(state)
    return state
  }

  async complete(state: ServerProvisioningState, step: ServerProvisioningStep): Promise<ServerProvisioningState> {
    const next = { ...state, completed: { ...state.completed, [step]: new Date().toISOString() } }
    await this.save(next)
    return next
  }

  async skipCompute(state: ServerProvisioningState): Promise<ServerProvisioningState> {
    const next = { ...state, computeSkipped: true }
    await this.save(next)
    return next
  }
}
