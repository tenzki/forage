import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  canonicalJson,
  createInitialOutlineState,
  parseEventEnvelope,
  reduceOutlineEvent,
  sha256Hex,
  type EventEnvelope,
  type OutlineState,
} from '@forage/domain'
import type { NotesCreateRequest, NotesCreateResponse } from '@forage/protocol'
import { createOutlineSchema, findSystemNode, repairSystemNodes } from '@forage/document'
import { InMemoryAgentStore, type AgentStore } from './agentStore.js'
import type { AgentDefinition, StructuredResult } from '@forage/agent-runtime'
import { resolveEffectiveToolIds, type RunInput } from '@forage/agent-runtime'
import { captureFacts, resolveAutomationMatches, type DispatcherClassifier } from './automation.js'

export type TokenScope = 'notes:create' | 'sync' | 'agents:read' | 'agents:execute' | 'agents:manage'

export interface Principal {
  tokenId: string
  ownerId: string
  outlineId: string
  scopes: TokenScope[]
  kind: 'api' | 'device'
}

export interface BootstrapResult {
  ownerId: string
  outlineId: string
  inboxId: string
  apiToken: string
  deviceToken: string
}

export interface CreateNoteResult {
  response: NotesCreateResponse
  replayed: boolean
}

export interface AssetRecord {
  assetId: string
  ownerId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  byteSize: number
  storageKey: string | null
  completed: boolean
}

export class RepositoryError extends Error {
  constructor(
    public readonly code: 'authentication_required' | 'authorization_denied' | 'upgrade_required' | 'conflict' | 'idempotency_conflict',
    message: string,
  ) {
    super(message)
  }
}

export interface ServerRepository {
  readonly instanceId: string
  readonly agentStore: AgentStore
  ready(): Promise<boolean>
  authenticate(secret: string, scope: TokenScope): Promise<Principal>
  currentRevision(outlineId: string): Promise<number>
  createNote(principal: Principal, key: string, input: NotesCreateRequest): Promise<CreateNoteResult>
  eventsAfter(outlineId: string, revision: number, limit: number): Promise<EventEnvelope[]>
  checkpoint(outlineId: string): Promise<{
    id: string; outlineId: string; documentVersion: number; schemaEpoch: number
    revision: number; integrityHash: string; state: OutlineState
  }>
  acceptEvents(principal: Principal, baseRevision: number, events: EventEnvelope[]): Promise<Array<{ eventId: string; revision: number }>>
  initiateAsset(principal: Principal, input: Omit<AssetRecord, 'ownerId' | 'storageKey' | 'completed'>): Promise<AssetRecord>
  completeAsset(principal: Principal, assetId: string, storageKey: string): Promise<AssetRecord>
  asset(principal: Principal, assetId: string): Promise<AssetRecord>
  runAdmissionContext(principal: Principal, sourceNodeId: string, targetParentId: string): Promise<{
    sourceText: string; context: string[]; baseRevision: number
  }>
  commitAgentResult(runId: string, workerId: string, result: StructuredResult): Promise<{
    firstRevision: number; lastRevision: number; rootNoteIds: string[]
  }>
  searchOutline(outlineId: string, query: string, limit?: number): Promise<Array<{ nodeId: string; text: string }>>
}

export interface DispatcherAgentContext {
  ownerId: string
  outlineId: string
  agent: AgentDefinition
}

interface TokenRecord extends Principal {
  secretHash: string
  revokedAt: string | null
  expiresAt: string | null
  lastUsedAt: string | null
}

interface IdempotencyRecord {
  requestHash: string
  response: NotesCreateResponse
}

interface NoteProjection {
  id: string
  parentId: string | null
  text: string
  deleted: boolean
}

export class InMemoryServerRepository implements ServerRepository {
  readonly instanceId: string
  readonly agentStore: AgentStore
  private ownerId = ''
  private outlineId = ''
  private inboxId = ''
  private revision = 0
  private state: OutlineState | null = null
  private readonly tokens = new Map<string, TokenRecord>()
  private readonly events: EventEnvelope[] = []
  private readonly notes = new Map<string, NoteProjection>()
  private readonly idempotency = new Map<string, IdempotencyRecord>()
  private readonly assets = new Map<string, AssetRecord>()
  private readonly supportedAgentToolIds: string[]
  private readonly credentialAvailable: (ownerId: string, outlineId: string, credentialId: string) => Promise<boolean>
  private readonly dispatcherForAgent?: (context: DispatcherAgentContext) => Promise<DispatcherClassifier | undefined>
  private readonly agentMaxAttempts: number

  constructor(options: {
    instanceId?: string
    supportedAgentToolIds?: string[]
    credentialAvailable?: (ownerId: string, outlineId: string, credentialId: string) => Promise<boolean>
    dispatcherForAgent?: (context: DispatcherAgentContext) => Promise<DispatcherClassifier | undefined>
    agentMaxAttempts?: number
  } = {}) {
    this.instanceId = options.instanceId ?? `instance_${randomUUID()}`
    this.agentStore = new InMemoryAgentStore()
    this.supportedAgentToolIds = options.supportedAgentToolIds ?? []
    this.credentialAvailable = options.credentialAvailable ?? (async () => false)
    this.dispatcherForAgent = options.dispatcherForAgent
    this.agentMaxAttempts = options.agentMaxAttempts ?? 3
  }

  async ready(): Promise<boolean> { return true }

  async bootstrapOwner(_email: string): Promise<BootstrapResult> {
    if (this.ownerId) throw new Error('The one-owner server is already bootstrapped.')
    this.ownerId = `owner_${randomUUID()}`
    this.outlineId = `outline_${randomUUID()}`
    this.inboxId = `note_${randomUUID()}`
    const dailyNotesId = `note_${randomUUID()}`
    const editableId = `note_${randomUUID()}`
    this.notes.set(this.inboxId, { id: this.inboxId, parentId: null, text: 'Inbox', deleted: false })
    this.notes.set(dailyNotesId, { id: dailyNotesId, parentId: null, text: 'Daily Notes', deleted: false })
    this.notes.set(editableId, { id: editableId, parentId: null, text: '', deleted: false })
    const systemIds = [this.inboxId, dailyNotesId]
    const repaired = repairSystemNodes({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: {
            nodeId: editableId, nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false,
            systemRole: null, dailyDate: null,
          },
          content: [{ type: 'paragraph' }],
        }],
      }],
    }, () => systemIds.shift()!)
    this.state = createInitialOutlineState(repaired.doc)
    const apiToken = this.issueToken('api', ['notes:create'])
    const deviceToken = this.issueToken('device', ['sync', 'agents:read', 'agents:execute', 'agents:manage'])
    return { ownerId: this.ownerId, outlineId: this.outlineId, inboxId: this.inboxId, apiToken, deviceToken }
  }

  private issueToken(kind: 'api' | 'device', scopes: TokenScope[]): string {
    const secret = `fg_${kind}_${randomBytes(32).toString('base64url')}`
    const tokenId = `token_${randomUUID()}`
    this.tokens.set(hashSecret(secret), {
      tokenId, ownerId: this.ownerId, outlineId: this.outlineId, scopes, kind,
      secretHash: hashSecret(secret), revokedAt: null, expiresAt: null, lastUsedAt: null,
    })
    return secret
  }

  async authenticate(secret: string, scope: TokenScope): Promise<Principal> {
    const record = this.tokens.get(hashSecret(secret))
    const now = new Date()
    if (!record || record.revokedAt || (record.expiresAt && new Date(record.expiresAt) <= now)) {
      throw new RepositoryError('authentication_required', 'Authentication is required.')
    }
    if (!record.scopes.includes(scope)) {
      throw new RepositoryError('authorization_denied', 'The token does not have the required scope.')
    }
    record.lastUsedAt = now.toISOString()
    return { tokenId: record.tokenId, ownerId: record.ownerId, outlineId: record.outlineId, scopes: [...record.scopes], kind: record.kind }
  }

  async currentRevision(outlineId: string): Promise<number> {
    this.requireOutline(outlineId)
    return this.revision
  }

  async createNote(principal: Principal, key: string, input: NotesCreateRequest): Promise<CreateNoteResult> {
    this.requireOutline(principal.outlineId)
    const requestHash = await sha256Hex(canonicalJson(input))
    const recordKey = `${principal.tokenId}:${key}`
    const existing = this.idempotency.get(recordKey)
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new RepositoryError('idempotency_conflict', 'The idempotency key was already used with different input.')
      }
      return { response: structuredClone(existing.response), replayed: true }
    }
    const canonicalInbox = findSystemNode(createOutlineSchema().nodeFromJSON(this.state!.doc), 'inbox')
    if (!canonicalInbox) throw new RepositoryError('conflict', 'The canonical Inbox is unavailable.')
    const parentId = input.parentId ?? canonicalInbox.id
    const parent = this.notes.get(parentId)
    if (!parent || parent.deleted) throw new RepositoryError('conflict', 'The requested parent does not exist or is deleted.')

    const noteId = `note_${randomUUID()}`
    const eventId = `event_${randomUUID()}`
    const createdAt = new Date().toISOString()
    const automaticRuns = parentId === canonicalInbox.id
      ? await this.automaticAdmissions(noteId, input, this.revision + 1)
      : []
    const event = parseEventEnvelope({
      id: eventId, outlineId: principal.outlineId, actorId: principal.ownerId,
      deviceId: `api_${principal.tokenId}`, type: 'note.created', eventVersion: 1,
      documentVersion: 1, schemaEpoch: 1, baseRevision: this.revision,
      revision: this.revision + 1, origin: 'notes_api', occurredAt: createdAt,
      payload: { noteId, parentId, text: input.text, source: input.source, clientCreatedAt: input.clientCreatedAt },
    })
    this.revision += 1
    this.events.push(event)
    this.state = reduceOutlineEvent(this.state!, event)
    this.notes.set(noteId, { id: noteId, parentId, text: input.text, deleted: false })
    const response: NotesCreateResponse = { noteId, eventId, revision: this.revision, parentId, origin: 'notes_api', createdAt }
    this.idempotency.set(recordKey, { requestHash, response: structuredClone(response) })
    for (const admission of automaticRuns) await this.agentStore.admitRun(admission)
    return { response, replayed: false }
  }

  private async automaticAdmissions(noteId: string, capture: NotesCreateRequest, baseRevision: number) {
    const [configurationRevision, automationRevision] = await Promise.all([
      this.agentStore.currentConfiguration(this.outlineId), this.agentStore.currentAutomation(this.outlineId),
    ])
    if (!configurationRevision || !automationRevision) return []
    const configuration = configurationRevision.configuration
    const matches = await resolveAutomationMatches(
      automationRevision.policies,
      captureFacts(capture.text, capture.source),
      { text: capture.text, source: capture.source ?? {} },
      async (agentId) => {
        const agent = configuration.agents.find((candidate) => candidate.id === agentId)
        if (!agent?.credentialRef || !this.dispatcherForAgent) return undefined
        if (!await this.credentialAvailable(this.ownerId, this.outlineId, agent.credentialRef)) return undefined
        return this.dispatcherForAgent({ ownerId: this.ownerId, outlineId: this.outlineId, agent })
      },
      AbortSignal.timeout(15_000),
    )
    const admissions: Array<Parameters<AgentStore['admitRun']>[0]> = []
    for (const match of matches) {
      const skill = configuration.skills.find((candidate) => candidate.id === match.skillId)
      const agent = skill ? configuration.agents.find((candidate) => candidate.id === skill.agentId) : undefined
      const credentialRef = agent?.credentialRef
      if (!skill || !agent || !credentialRef || !await this.credentialAvailable(this.ownerId, this.outlineId, credentialRef)) continue
      let effectiveToolIds: string[]
      try {
        effectiveToolIds = resolveEffectiveToolIds({
          agentToolIds: agent.toolIds, requiredToolIds: skill.requiredToolIds,
          globallyEnabledToolIds: configuration.globallyEnabledToolIds,
          policyAllowedToolIds: configuration.globallyEnabledToolIds,
          executorSupportedToolIds: this.supportedAgentToolIds,
        })
      } catch { continue }
      const input: RunInput = {
        version: 1, runId: `run_${randomUUID()}`, executionMode: 'server', outlineId: this.outlineId,
        source: { nodeId: noteId, text: capture.text, ...(capture.source ? { properties: capture.source } : {}) },
        target: { parentId: noteId }, baseRevision, configurationRevision: configuration.revision,
        credentialRef, agent, skill, effectiveToolIds,
        prompt: 'Process this Inbox capture using the selected skill.', context: [capture.text],
        customTools: configuration.customTools,
      }
      admissions.push({
        input, ownerId: this.ownerId, trigger: 'inbox_automation',
        triggerIdentity: `capture:${noteId}:policy:${automationRevision.policies.revision}:skill:${skill.id}`,
        policyId: match.policyId, maxAttempts: this.agentMaxAttempts,
      })
    }
    return admissions
  }

  async eventsAfter(outlineId: string, revision: number, limit: number): Promise<EventEnvelope[]> {
    this.requireOutline(outlineId)
    return this.events.filter((event) => (event.revision ?? 0) > revision).slice(0, limit).map((event) => structuredClone(event))
  }

  async checkpoint(outlineId: string) {
    this.requireOutline(outlineId)
    const state = structuredClone(this.state!)
    return {
      id: `checkpoint_${randomUUID()}`, outlineId, documentVersion: 1, schemaEpoch: 1,
      revision: this.revision, integrityHash: await sha256Hex(canonicalJson(state)), state,
    }
  }

  async acceptEvents(principal: Principal, baseRevision: number, events: EventEnvelope[]) {
    this.requireOutline(principal.outlineId)
    if (baseRevision !== this.revision) throw new RepositoryError('conflict', 'rebase_required')
    const acknowledgements: Array<{ eventId: string; revision: number }> = []
    for (const candidate of events) {
      const duplicate = this.events.find((event) => event.id === candidate.id)
      if (duplicate) {
        if (!sameEventContent(duplicate, candidate)) {
          throw new RepositoryError('conflict', `Event id ${candidate.id} was reused with different content.`)
        }
        acknowledgements.push({ eventId: duplicate.id, revision: duplicate.revision! })
        continue
      }
      requireCompatibleEvent(candidate)
      this.requireCompletedAssets(principal, candidate)
      this.revision += 1
      const accepted = parseEventEnvelope({
        ...candidate, outlineId: principal.outlineId, baseRevision: this.revision - 1, revision: this.revision,
      })
      this.events.push(accepted)
      this.state = reduceOutlineEvent(this.state!, accepted)
      acknowledgements.push({ eventId: accepted.id, revision: this.revision })
    }
    return acknowledgements
  }

  async initiateAsset(
    principal: Principal,
    input: Omit<AssetRecord, 'ownerId' | 'storageKey' | 'completed'>,
  ): Promise<AssetRecord> {
    this.requireOutline(principal.outlineId)
    const existing = this.assets.get(input.assetId)
    if (existing) {
      if (existing.ownerId !== principal.ownerId) throw hiddenAssetError()
      if (existing.mediaType !== input.mediaType || existing.byteSize !== input.byteSize) {
        throw new RepositoryError('conflict', 'Asset metadata does not match the existing upload.')
      }
      return structuredClone(existing)
    }
    const record: AssetRecord = { ...input, ownerId: principal.ownerId, storageKey: null, completed: false }
    this.assets.set(input.assetId, record)
    return structuredClone(record)
  }

  async completeAsset(principal: Principal, assetId: string, storageKey: string): Promise<AssetRecord> {
    const record = this.assets.get(assetId)
    if (!record || record.ownerId !== principal.ownerId) throw hiddenAssetError()
    record.storageKey = storageKey
    record.completed = true
    return structuredClone(record)
  }

  async asset(principal: Principal, assetId: string): Promise<AssetRecord> {
    const record = this.assets.get(assetId)
    if (!record || record.ownerId !== principal.ownerId || !record.completed) throw hiddenAssetError()
    return structuredClone(record)
  }

  async runAdmissionContext(principal: Principal, sourceNodeId: string, targetParentId: string) {
    this.requireOutline(principal.outlineId)
    const source = this.notes.get(sourceNodeId)
    const target = this.notes.get(targetParentId)
    if (!source || source.deleted || !target || target.deleted) throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
    const context: string[] = []
    let current: NoteProjection | undefined = target
    while (current && context.length < 20) {
      context.unshift(current.text)
      current = current.parentId ? this.notes.get(current.parentId) : undefined
    }
    return { sourceText: source.text, context, baseRevision: this.revision }
  }

  async searchOutline(outlineId: string, query: string, limit = 20) {
    this.requireOutline(outlineId)
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return [...this.notes.values()].filter((note) => !note.deleted && note.text.toLowerCase().includes(needle))
      .slice(0, Math.max(1, Math.min(limit, 50))).map((note) => ({ nodeId: note.id, text: note.text.slice(0, 2_000) }))
  }

  async commitAgentResult(runId: string, workerId: string, result: StructuredResult) {
    const run = await this.agentStore.getRun(this.outlineId, runId)
    if (!run) throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
    const target = this.notes.get(run.input.target.parentId)
    if (!target || target.deleted) {
      await this.agentStore.fail(runId, workerId, 'target_unavailable', false, new Date(), 0)
      throw new RepositoryError('conflict', 'The target is unavailable.')
    }
    const ownership = await this.agentStore.renewLease(runId, workerId, new Date(), 60_000)
    if (!ownership.owned) throw new RepositoryError('conflict', 'Run lease was lost.')
    if (ownership.cancelRequested) throw new RepositoryError('conflict', 'Run cancellation was requested.')
    const rootNoteIds: string[] = []
    const firstRevision = this.revision + 1
    const changeGroupId = `run_${runId}`.slice(0, 128)
    const provenance = { runId, skillId: run.skillId, sourceNodeId: run.input.source.nodeId, sourceUrls: result.sources.map((source) => source.url).slice(0, 20) }
    const addNodes = (nodes: StructuredResult['nodes'], parentId: string): void => {
      for (const node of nodes) {
        if (node.type === 'image') {
          const event = parseEventEnvelope({
            id: `event_${randomUUID()}`, outlineId: run.outlineId, actorId: this.ownerId, deviceId: `agent_${this.instanceId}`,
            type: 'asset.reference_added', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
            baseRevision: this.revision, revision: this.revision + 1, origin: 'agent', agentProvenance: provenance,
            changeGroupId, occurredAt: new Date().toISOString(), payload: { assetId: node.assetId, alt: node.alt },
          })
          this.revision += 1; this.events.push(event); this.state = reduceOutlineEvent(this.state!, event)
          continue
        }
        const noteId = `note_${randomUUID()}`
        if (parentId === run.input.target.parentId) rootNoteIds.push(noteId)
        const event = parseEventEnvelope({
          id: `event_${randomUUID()}`, outlineId: run.outlineId, actorId: this.ownerId, deviceId: `agent_${this.instanceId}`,
          type: 'note.created', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
          baseRevision: this.revision, revision: this.revision + 1, origin: 'agent', agentProvenance: provenance,
          changeGroupId, occurredAt: new Date().toISOString(), payload: { noteId, parentId, text: node.text },
        })
        this.revision += 1; this.events.push(event); this.state = reduceOutlineEvent(this.state!, event)
        this.notes.set(noteId, { id: noteId, parentId, text: node.text, deleted: false })
        if (node.children?.length) addNodes(node.children, noteId)
      }
    }
    addNodes(result.nodes, run.input.target.parentId)
    if (!rootNoteIds.length) throw new RepositoryError('conflict', 'Structured result must contain a text root.')
    const settled = { firstRevision, lastRevision: this.revision, rootNoteIds }
    return this.agentStore.complete(runId, workerId, `result:${runId}`, settled)
  }

  private requireCompletedAssets(principal: Principal, event: EventEnvelope): void {
    for (const assetId of referencedAssetIds(event.payload)) {
      const record = this.assets.get(assetId)
      if (!record || !record.completed || record.ownerId !== principal.ownerId) {
        throw new RepositoryError('conflict', 'The event references an unavailable asset.')
      }
    }
  }

  private requireOutline(outlineId: string): void {
    if (!this.outlineId || outlineId !== this.outlineId) {
      throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
    }
  }
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function referencedAssetIds(value: unknown): string[] {
  const found = new Set<string>()
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) return candidate.forEach(visit)
    if (!candidate || typeof candidate !== 'object') return
    for (const [key, child] of Object.entries(candidate)) {
      if (key === 'assetId' && typeof child === 'string') found.add(child)
      else visit(child)
    }
  }
  visit(value)
  return [...found]
}

function hiddenAssetError(): RepositoryError {
  return new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
}

export function requireCompatibleEvent(event: EventEnvelope, documentVersion = 1, schemaEpoch = 1): void {
  if (event.eventVersion !== 1 || event.documentVersion !== documentVersion || event.schemaEpoch !== schemaEpoch) {
    throw new RepositoryError('upgrade_required', 'The event or document version is not supported by this server.')
  }
}

export function sameEventContent(left: EventEnvelope, right: EventEnvelope): boolean {
  const content = (event: EventEnvelope) => canonicalJson({
    id: event.id, outlineId: event.outlineId, actorId: event.actorId, deviceId: event.deviceId,
    type: event.type, eventVersion: event.eventVersion, documentVersion: event.documentVersion,
    schemaEpoch: event.schemaEpoch, origin: event.origin, occurredAt: event.occurredAt,
    changeGroupId: event.changeGroupId, payload: event.payload,
    agentProvenance: event.agentProvenance,
  })
  return content(left) === content(right)
}
