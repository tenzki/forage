import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  canonicalJson,
  parseEventEnvelope,
  reduceOutlineEvent,
  sha256Hex,
  type EventEnvelope,
  type OutlineState,
} from '@forage/domain'
import type { NotesCreateRequest, NotesCreateResponse } from '@forage/protocol'
import { createOutlineSchema, findSystemNode, queryCanonicalOutline } from '@forage/document'
import { InMemoryAgentStore, type AgentStore } from './agentStore.js'
import type { AgentDefinition, StructuredResult } from '@forage/agent-runtime'
import { resolveEffectiveToolIds, type RunInput } from '@forage/agent-runtime'
import { captureFacts, resolveAutomationMatches, type DispatcherClassifier } from './automation.js'

export type TokenScope = 'notes:create' | 'sync' | 'agents:read' | 'agents:execute' | 'agents:manage'

export interface Principal {
  tokenId: string
  ownerId: string
  outlineId: string | null
  scopes: TokenScope[]
  kind: 'api' | 'device'
}

/** A principal whose credential has been bound to an outline by claiming it. */
export type BoundPrincipal = Principal & { outlineId: string }

export function requireBoundOutline(principal: Principal): BoundPrincipal {
  if (!principal.outlineId) {
    throw new RepositoryError('conflict', 'This credential is not bound to an outline yet.')
  }
  return principal as BoundPrincipal
}

export interface BootstrapResult {
  ownerId: string
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
    public readonly code:
      | 'authentication_required' | 'authorization_denied' | 'upgrade_required' | 'conflict' | 'idempotency_conflict'
      | 'outline_not_synchronized' | 'source_missing' | 'source_trashed' | 'target_missing' | 'target_trashed'
      | 'configuration_unavailable' | 'configuration_conflict' | 'compute_unavailable'
      | 'capability_unavailable' | 'projection_rebuilding' | 'worker_unavailable',
    message: string,
    public readonly recoveryAction?: string,
  ) {
    super(message)
  }
}

export interface ServerRepository {
  readonly instanceId: string
  readonly agentStore: AgentStore
  ready(): Promise<boolean>
  authenticate(secret: string, scope: TokenScope): Promise<Principal>
  claimOutline(principal: Principal, input: { outlineId: string; name: string }): Promise<{ outlineId: string; state: 'seeding' | 'ready' }>
  seedOutline(principal: BoundPrincipal, state: OutlineState): Promise<{ outlineId: string; revision: number; integrityHash: string }>
  outlineState(outlineId: string): Promise<'seeding' | 'ready'>
  currentRevision(outlineId: string): Promise<number>
  createNote(principal: BoundPrincipal, key: string, input: NotesCreateRequest): Promise<CreateNoteResult>
  eventsAfter(outlineId: string, revision: number, limit: number): Promise<EventEnvelope[]>
  checkpoint(outlineId: string): Promise<{
    id: string; outlineId: string; documentVersion: number; schemaEpoch: number
    revision: number; integrityHash: string; state: OutlineState
  }>
  acceptEvents(principal: BoundPrincipal, baseRevision: number, events: EventEnvelope[]): Promise<Array<{ eventId: string; revision: number }>>
  initiateAsset(principal: BoundPrincipal, input: Omit<AssetRecord, 'ownerId' | 'storageKey' | 'completed'>): Promise<AssetRecord>
  completeAsset(principal: BoundPrincipal, assetId: string, storageKey: string): Promise<AssetRecord>
  asset(principal: BoundPrincipal, assetId: string): Promise<AssetRecord>
  runAdmissionContext(principal: BoundPrincipal, sourceNodeId: string, targetParentId: string): Promise<{
    sourceText: string; context: string[]; baseRevision: number
  }>
  commitAgentResult(runId: string, workerId: string, result: StructuredResult): Promise<
    | { placement: 'placed'; firstRevision: number; lastRevision: number; rootNoteIds: string[] }
    | { placement: 'unplaced'; reason: string }
  >
  searchOutline(outlineId: string, query: string, limit?: number): Promise<Array<{ nodeId: string; text: string }>>
  noteIndexStatus(outlineId: string): Promise<{ ready: boolean; sourceRevision: number; schemaVersion: number }>
  placeAgentResult(principal: BoundPrincipal, runId: string, targetNodeId: string): Promise<{
    firstRevision: number; lastRevision: number; rootNoteIds: string[]
  }>
}

export interface DispatcherAgentContext {
  ownerId: string
  outlineId: string
  agent: AgentDefinition
}

interface TokenRecord extends Omit<Principal, 'outlineId'> {
  outlineId: string | null
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
  private outlineStateValue: 'seeding' | 'ready' = 'seeding'
  private seedIntegrityHash: string | null = null
  private revision = 0
  private state: OutlineState | null = null
  private readonly tokens = new Map<string, TokenRecord>()
  private readonly events: EventEnvelope[] = []
  private readonly notes = new Map<string, NoteProjection>()
  private noteProjectorRevision = 0
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
    const apiToken = this.issueToken('api', ['notes:create'])
    const deviceToken = this.issueToken('device', ['sync', 'agents:read', 'agents:execute', 'agents:manage'])
    return { ownerId: this.ownerId, apiToken, deviceToken }
  }

  async claimOutline(
    principal: Principal,
    input: { outlineId: string; name: string },
  ): Promise<{ outlineId: string; state: 'seeding' | 'ready' }> {
    if (principal.ownerId !== this.ownerId) {
      throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
    }
    if (this.outlineId) {
      if (this.outlineId !== input.outlineId || principal.outlineId !== this.outlineId) {
        throw new RepositoryError('conflict', 'This server already holds an outline.')
      }
      return { outlineId: this.outlineId, state: this.outlineStateValue }
    }
    this.outlineId = input.outlineId
    this.outlineStateValue = 'seeding'
    // Every credential the owner already holds attaches to the outline they have just
    // claimed. Binding only the claiming device would strand the capture token forever.
    for (const record of this.tokens.values()) {
      if (record.ownerId === this.ownerId && record.outlineId === null) record.outlineId = this.outlineId
    }
    return { outlineId: this.outlineId, state: 'seeding' }
  }

  async outlineState(outlineId: string): Promise<'seeding' | 'ready'> {
    this.requireOutline(outlineId)
    return this.outlineStateValue
  }

  async seedOutline(
    principal: BoundPrincipal,
    state: OutlineState,
  ): Promise<{ outlineId: string; revision: number; integrityHash: string }> {
    this.requireOutline(principal.outlineId)
    const integrityHash = await sha256Hex(canonicalJson(state))
    if (this.outlineStateValue === 'ready') {
      if (this.seedIntegrityHash === integrityHash) {
        return { outlineId: this.outlineId, revision: 0, integrityHash }
      }
      throw new RepositoryError('conflict', 'This outline has already been seeded.')
    }
    const inbox = findSystemNode(createOutlineSchema().nodeFromJSON(state.doc), 'inbox')
    if (!inbox) throw new RepositoryError('conflict', 'The seed document has no Inbox node.')
    for (const assetId of referencedAssetIds(state)) {
      const asset = this.assets.get(assetId)
      if (!asset?.completed) {
        throw new RepositoryError('conflict', `The seed references an asset that is not uploaded: ${assetId}`)
      }
    }
    this.state = state
    this.revision = 0
    this.notes.clear()
    for (const note of noteProjectionsFromState(state)) {
      this.notes.set(note.id, { id: note.id, parentId: note.parentId, text: note.text, deleted: false })
    }
    this.outlineStateValue = 'ready'
    this.noteProjectorRevision = 0
    this.seedIntegrityHash = integrityHash
    return { outlineId: this.outlineId, revision: 0, integrityHash }
  }

  private issueToken(kind: 'api' | 'device', scopes: TokenScope[]): string {
    const secret = `fg_${kind}_${randomBytes(32).toString('base64url')}`
    const tokenId = `token_${randomUUID()}`
    this.tokens.set(hashSecret(secret), {
      tokenId, ownerId: this.ownerId, outlineId: this.outlineId || null, scopes, kind,
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

  async createNote(principal: BoundPrincipal, key: string, input: NotesCreateRequest): Promise<CreateNoteResult> {
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
    requireLiveCanonicalNode(queryCanonicalOutline(this.state!), parentId, 'target')

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
    const computeRevision = await this.agentStore.currentComputeProfile(this.outlineId)
    if (!configurationRevision || !automationRevision || !computeRevision) return []
    const configuration = configurationRevision.configuration
    const compute = computeRevision.profile
    const matches = await resolveAutomationMatches(
      automationRevision.policies,
      captureFacts(capture.text, capture.source),
      { text: capture.text, source: capture.source ?? {} },
      async (agentId) => {
        const agent = configuration.agents.find((candidate) => candidate.id === agentId)
        if (!agent || !this.dispatcherForAgent) return undefined
        if (!await this.credentialAvailable(this.ownerId, this.outlineId, compute.credentialRef)) return undefined
        return this.dispatcherForAgent({ ownerId: this.ownerId, outlineId: this.outlineId, agent: { ...agent, modelId: compute.modelId, credentialRef: compute.credentialRef } })
      },
      AbortSignal.timeout(15_000),
    )
    const admissions: Array<Parameters<AgentStore['admitRun']>[0]> = []
    for (const match of matches) {
      const skill = configuration.skills.find((candidate) => candidate.id === match.skillId)
      const agent = skill ? configuration.agents.find((candidate) => candidate.id === skill.agentId) : undefined
      const credentialRef = compute.credentialRef
      if (!skill || !agent || !await this.credentialAvailable(this.ownerId, this.outlineId, credentialRef)) continue
      const resolvedAgent = { ...agent, modelId: compute.modelId, credentialRef }
      let effectiveToolIds: string[]
      try {
        effectiveToolIds = resolveEffectiveToolIds({
          agentToolIds: resolvedAgent.toolIds, requiredToolIds: skill.requiredToolIds,
          globallyEnabledToolIds: configuration.globallyEnabledToolIds,
          policyAllowedToolIds: configuration.globallyEnabledToolIds,
          executorSupportedToolIds: this.supportedAgentToolIds,
        })
      } catch { continue }
      const input: RunInput = {
        version: 1, runId: `run_${randomUUID()}`, executionMode: 'server', outlineId: this.outlineId,
        source: { nodeId: noteId, text: capture.text, ...(capture.source ? { properties: capture.source } : {}) },
        target: { parentId: noteId }, baseRevision, configurationRevision: configuration.revision,
        credentialRef, agent: resolvedAgent, skill, effectiveToolIds,
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

  async acceptEvents(principal: BoundPrincipal, baseRevision: number, events: EventEnvelope[]) {
    this.requireOutline(principal.outlineId)
    if (baseRevision !== this.revision) throw new RepositoryError('conflict', 'rebase_required')
    const acknowledgements: Array<{ eventId: string; revision: number }> = []
    let changed = false
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
      changed = true
      acknowledgements.push({ eventId: accepted.id, revision: this.revision })
    }
    if (changed) this.rebuildNoteIndex()
    return acknowledgements
  }

  async initiateAsset(
    principal: BoundPrincipal,
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

  async completeAsset(principal: BoundPrincipal, assetId: string, storageKey: string): Promise<AssetRecord> {
    const record = this.assets.get(assetId)
    if (!record || record.ownerId !== principal.ownerId) throw hiddenAssetError()
    record.storageKey = storageKey
    record.completed = true
    return structuredClone(record)
  }

  async asset(principal: BoundPrincipal, assetId: string): Promise<AssetRecord> {
    const record = this.assets.get(assetId)
    if (!record || record.ownerId !== principal.ownerId || !record.completed) throw hiddenAssetError()
    return structuredClone(record)
  }

  async runAdmissionContext(principal: BoundPrincipal, sourceNodeId: string, targetParentId: string) {
    this.requireOutline(principal.outlineId)
    const canonical = queryCanonicalOutline(this.state!)
    const source = requireLiveCanonicalNode(canonical, sourceNodeId, 'source')
    const target = requireLiveCanonicalNode(canonical, targetParentId, 'target')
    return {
      sourceText: source.text,
      context: canonical.ancestors(target.id).map((node) => node.text),
      baseRevision: this.revision,
    }
  }

  async searchOutline(outlineId: string, query: string, limit = 20) {
    this.requireOutline(outlineId)
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    if (this.noteProjectorRevision !== this.revision) this.rebuildNoteIndex()
    return [...this.notes.values()].filter((note) => !note.deleted && note.text.toLowerCase().includes(needle))
      .slice(0, Math.max(1, Math.min(limit, 50))).map((note) => ({ nodeId: note.id, text: note.text.slice(0, 2_000) }))
  }

  async noteIndexStatus(outlineId: string) {
    this.requireOutline(outlineId)
    return { ready: this.noteProjectorRevision === this.revision, sourceRevision: this.noteProjectorRevision, schemaVersion: NOTE_PROJECTOR_SCHEMA_VERSION }
  }

  async commitAgentResult(runId: string, workerId: string, result: StructuredResult) {
    const run = await this.agentStore.getRun(this.outlineId, runId)
    if (!run) throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
    await this.agentStore.persistOutput(runId, workerId, `result:${runId}`, result)
    const target = queryCanonicalOutline(this.state!).resolve(run.input.target.parentId)
    if (target.state !== 'live') {
      await this.agentStore.completeUnplaced(runId, workerId, `target_${target.state}`)
      return { placement: 'unplaced' as const, reason: `target_${target.state}` }
    }
    const ownership = await this.agentStore.renewLease(runId, workerId, new Date(), 60_000)
    if (!ownership.owned) throw new RepositoryError('conflict', 'Run lease was lost.')
    if (ownership.cancelRequested) throw new RepositoryError('conflict', 'Run cancellation was requested.')
    const nodes = assignResultNodeIds(result.nodes, runId)
    const rootNoteIds = nodes.filter((node) => node.type === 'text').map((node) => node.nodeId)
    if (!rootNoteIds.length) throw new RepositoryError('conflict', 'Structured result must contain a text root.')
    const provenance = { runId, skillId: run.skillId, sourceNodeId: run.input.source.nodeId, sourceUrls: result.sources.map((source) => source.url).slice(0, 20) }
    const event = parseEventEnvelope({
      id: `event_${randomUUID()}`, outlineId: run.outlineId, actorId: this.ownerId, deviceId: `agent_${this.instanceId}`,
      type: 'agent.result_committed', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: this.revision, revision: this.revision + 1, origin: 'agent', agentProvenance: provenance,
      changeGroupId: `run_${runId}`.slice(0, 128), occurredAt: new Date().toISOString(),
      payload: { runId, targetNodeId: run.input.target.parentId, nodes, sources: result.sources },
    })
    this.revision += 1
    this.events.push(event)
    this.state = reduceOutlineEvent(this.state!, event)
    const settled = { firstRevision: this.revision, lastRevision: this.revision, rootNoteIds }
    this.rebuildNoteIndex()
    await this.agentStore.complete(runId, workerId, `result:${runId}`, settled)
    return { placement: 'placed' as const, ...settled }
  }

  async placeAgentResult(principal: BoundPrincipal, runId: string, targetNodeId: string) {
    this.requireOutline(principal.outlineId)
    const run = await this.agentStore.getRun(principal.outlineId, runId)
    const output = await this.agentStore.output(runId)
    if (!run || !output) throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
    requireLiveCanonicalNode(queryCanonicalOutline(this.state!), targetNodeId, 'target')
    if (run.result) return run.result
    if (run.status !== 'completed_unplaced') throw new RepositoryError('conflict', 'Run output is not awaiting placement.')
    const nodes = assignResultNodeIds(output.result.nodes, runId)
    const rootNoteIds = nodes.filter((node) => node.type === 'text').map((node) => node.nodeId)
    if (!rootNoteIds.length) throw new RepositoryError('conflict', 'Structured result must contain a text root.')
    const revision = this.revision + 1
    const event = parseEventEnvelope({
      id: `event_${randomUUID()}`, outlineId: run.outlineId, actorId: principal.ownerId, deviceId: `agent_${this.instanceId}`,
      type: 'agent.result_committed', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: this.revision, revision, origin: 'agent',
      agentProvenance: { runId, skillId: run.skillId, sourceNodeId: run.input.source.nodeId, sourceUrls: output.result.sources.map((source) => source.url) },
      changeGroupId: `run_${runId}`.slice(0, 128), occurredAt: new Date().toISOString(),
      payload: { runId, targetNodeId, nodes, sources: output.result.sources },
    })
    this.revision = revision
    this.events.push(event)
    this.state = reduceOutlineEvent(this.state!, event)
    this.rebuildNoteIndex()
    return this.agentStore.placeOutput(principal.outlineId, runId, output.resultIdentity, {
      firstRevision: revision, lastRevision: revision, rootNoteIds,
    })
  }

  private rebuildNoteIndex(): void {
    const visible = new Set<string>()
    for (const note of noteProjectionsFromState(this.state!)) {
      visible.add(note.id)
      this.notes.set(note.id, { ...note, deleted: false })
    }
    for (const [id, note] of this.notes) {
      if (!visible.has(id)) this.notes.set(id, { ...note, deleted: true })
    }
    this.noteProjectorRevision = this.revision
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

export const NOTE_PROJECTOR_SCHEMA_VERSION = 1

function assignResultNodeIds(nodes: StructuredResult['nodes'], runId: string, prefix = ''): Array<
  | { type: 'text'; nodeId: string; text: string; children?: ReturnType<typeof assignResultNodeIds> }
  | { type: 'image'; assetId: string; alt: string }
> {
  return nodes.map((node, index) => node.type === 'image' ? node : ({
    type: 'text' as const,
    nodeId: `note_${runId}_${prefix}${index}`.slice(0, 128),
    text: node.text,
    ...(node.children?.length ? { children: assignResultNodeIds(node.children, runId, `${prefix}${index}_`) } : {}),
  }))
}

function canonicalNodeError(kind: 'source' | 'target', state: 'missing' | 'trashed'): RepositoryError {
  const code = `${kind}_${state}` as 'source_missing' | 'source_trashed' | 'target_missing' | 'target_trashed'
  return new RepositoryError(code, `The ${kind} node is ${state}.`, state === 'trashed' ? 'restore_or_choose_another' : 'choose_another')
}

function requireLiveCanonicalNode(
  query: ReturnType<typeof queryCanonicalOutline>,
  nodeId: string,
  kind: 'source' | 'target',
) {
  const resolution = query.resolve(nodeId)
  if (resolution.state !== 'live') throw canonicalNodeError(kind, resolution.state)
  return resolution.node
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

interface DocumentNodeJson {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: DocumentNodeJson[]
}

function paragraphText(node: DocumentNodeJson): string {
  const paragraph = (node.content ?? []).find((child) => child.type === 'paragraph')
  return (paragraph?.content ?? []).map((child) => (typeof child.text === 'string' ? child.text : '')).join('')
}

/**
 * Derives the flat note projection from a document state. Server mode keeps this
 * projection beside the document so the notes API can resolve parents without
 * replaying ProseMirror.
 */
export function noteProjectionsFromState(
  state: OutlineState,
): Array<{ id: string; parentId: string | null; text: string }> {
  const notes: Array<{ id: string; parentId: string | null; text: string }> = []
  const visit = (node: DocumentNodeJson, parentId: string | null): void => {
    const nodeId = node.attrs?.nodeId
    if (node.type === 'listItem' && typeof nodeId === 'string') {
      notes.push({ id: nodeId, parentId, text: paragraphText(node) })
      for (const child of node.content ?? []) visit(child, nodeId)
      return
    }
    for (const child of node.content ?? []) visit(child, parentId)
  }
  visit(state.doc as DocumentNodeJson, null)
  return notes
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
