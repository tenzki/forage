import {
  createLocalExtensionSnapshotFromCatalog,
  createLocalExtensionExecutorSnapshotFromCatalog,
  localExtensionSnapshotSchema,
  localExtensionExecutorSnapshotSchema,
  type ExtensionCatalog,
  type ExtensionConfiguration,
  type LocalExtensionSnapshot,
  type LocalExtensionExecutorSnapshot,
} from '@forage/agent-runtime'

export class ExtensionSnapshotError extends Error {
  constructor(readonly code: 'unavailable_extension_revision' | 'stale_extension_revision', message: string) {
    super(message)
    this.name = 'ExtensionSnapshotError'
  }
}

export function createLocalExtensionExecutorSnapshot(
  catalog: ExtensionCatalog,
  configuration: ExtensionConfiguration,
  selection: { extensionId: string; executorId: string },
): LocalExtensionExecutorSnapshot {
  return createLocalExtensionExecutorSnapshotFromCatalog(catalog, configuration.revision, selection)
}

export function verifyLocalExtensionExecutorSnapshot(
  snapshot: LocalExtensionExecutorSnapshot,
  catalog: ExtensionCatalog,
  configuration: ExtensionConfiguration,
): ExtensionCatalog['entries'][number] {
  const parsed = localExtensionExecutorSnapshotSchema.parse(snapshot)
  if (parsed.configurationRevision !== configuration.revision || parsed.catalogRevision !== catalog.revision) {
    throw new ExtensionSnapshotError('stale_extension_revision', 'Extension catalog or local configuration changed after executor admission; retry against the current catalog.')
  }
  const entry = catalog.entries.find((candidate) => candidate.source.installationId === parsed.source.installationId)
  if (!entry || entry.status !== 'ready' || !entry.manifest || !entry.provenance?.entryDigest) {
    throw new ExtensionSnapshotError('unavailable_extension_revision', 'The admitted skill executor revision is no longer available.')
  }
  if (entry.manifest.id !== parsed.source.extensionId
    || entry.provenance.sourceRevision !== parsed.source.sourceRevision
    || entry.provenance.entryDigest !== parsed.source.entryDigest) {
    throw new ExtensionSnapshotError('stale_extension_revision', 'The skill executor source changed after admission.')
  }
  const executor = (entry.executors ?? []).find((candidate) => candidate.id === parsed.source.executorId)
  if (!executor?.available) {
    throw new ExtensionSnapshotError('unavailable_extension_revision', 'The admitted skill executor is unavailable.')
  }
  return entry
}

export function createLocalExtensionSnapshot(
  catalog: ExtensionCatalog,
  configuration: ExtensionConfiguration,
  admittedToolIds: readonly string[],
): LocalExtensionSnapshot {
  return createLocalExtensionSnapshotFromCatalog(catalog, configuration.revision, admittedToolIds)
}

export function verifyLocalExtensionSnapshot(
  snapshot: LocalExtensionSnapshot,
  catalog: ExtensionCatalog,
  configuration: ExtensionConfiguration,
): void {
  const parsed = localExtensionSnapshotSchema.parse(snapshot)
  if (parsed.configurationRevision !== configuration.revision || parsed.catalogRevision !== catalog.revision) {
    throw new ExtensionSnapshotError('stale_extension_revision', 'Extension catalog or configuration changed after run admission; retry against the current catalog.')
  }
  for (const source of parsed.sources) {
    const entry = catalog.entries.find((candidate) => candidate.source.installationId === source.installationId)
    if (!entry || entry.status !== 'ready' || !entry.manifest || !entry.provenance?.entryDigest) {
      throw new ExtensionSnapshotError('unavailable_extension_revision', `Extension revision ${source.installationId} is no longer available.`)
    }
    const current = entry.provenance
    if (entry.manifest.id !== source.extensionId || current.sourceRevision !== source.sourceRevision || current.entryDigest !== source.entryDigest) {
      throw new ExtensionSnapshotError('stale_extension_revision', `Extension revision ${source.installationId} changed after run admission.`)
    }
    const availableTools = new Set(entry.tools.filter((tool) => tool.available).map((tool) => tool.id))
    if (source.toolIds.some((toolId) => !availableTools.has(toolId))) {
      throw new ExtensionSnapshotError('unavailable_extension_revision', `An admitted tool from ${source.installationId} is unavailable.`)
    }
  }
}

export class ExtensionRevisionRegistry<T> {
  private current: { revision: string; value: T } | undefined
  private readonly retained = new Map<string, { value: T; users: number }>()

  reload(revision: string, value: T): void {
    this.current = { revision, value }
    if (!this.retained.has(revision)) this.retained.set(revision, { value, users: 0 })
    this.collect()
  }

  acquire(): { revision: string; value: T; release: () => void } {
    if (!this.current) throw new Error('No extension revision has been loaded.')
    const selected = this.current
    const retained = this.retained.get(selected.revision)!
    retained.users += 1
    let released = false
    return {
      ...selected,
      release: () => {
        if (released) return
        released = true
        retained.users -= 1
        this.collect()
      },
    }
  }

  private collect(): void {
    for (const [revision, retained] of this.retained) {
      if (revision !== this.current?.revision && retained.users === 0) this.retained.delete(revision)
    }
  }
}
