export interface UnknownEventEnvelope {
  id: string
  outlineId: string
  actorId: string
  deviceId: string
  type: string
  eventVersion: number
  documentVersion: number
  schemaEpoch: number
  baseRevision: number
  revision?: number
  origin: string
  occurredAt: string
  changeGroupId?: string
  payload: Record<string, unknown>
}

export type EventUpcaster = (event: UnknownEventEnvelope) => UnknownEventEnvelope

export class EventUpcasterRegistry {
  private readonly upcasters = new Map<string, EventUpcaster>()

  register(type: string, fromVersion: number, upcaster: EventUpcaster): void {
    const key = `${type}:${fromVersion}`
    if (this.upcasters.has(key)) throw new Error(`Upcaster already registered for ${key}`)
    this.upcasters.set(key, upcaster)
  }

  upcast(event: UnknownEventEnvelope, supportedVersion: number): UnknownEventEnvelope {
    if (event.eventVersion > supportedVersion) {
      throw new Error(`Unknown future event version ${event.eventVersion} for ${event.type}`)
    }
    let current = structuredClone(event)
    while (current.eventVersion < supportedVersion) {
      const key = `${current.type}:${current.eventVersion}`
      const upcaster = this.upcasters.get(key)
      if (!upcaster) throw new Error(`Missing event upcaster for ${key}`)
      const next = upcaster(current)
      if (next.eventVersion !== current.eventVersion + 1) {
        throw new Error(`Upcaster ${key} must advance exactly one version`)
      }
      current = next
    }
    return current
  }
}
