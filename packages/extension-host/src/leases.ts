import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ExtensionCatalog, LocalExtensionSnapshot } from '@forage/agent-runtime'
import { ExtensionConfigurationStore } from './configuration'

const REMOVAL_MARKER = '.remove-pending'

export interface ManagedRevisionLease {
  release(): Promise<void>
}

export async function acquireManagedRevisionLeases(
  configurationRoot: string,
  snapshot: LocalExtensionSnapshot,
  catalog: ExtensionCatalog,
): Promise<ManagedRevisionLease> {
  const store = new ExtensionConfigurationStore({ root: configurationRoot })
  const leases: Array<{ installationId: string; leasePath: string }> = []
  try {
    for (const admitted of snapshot.sources) {
      const entry = catalog.entries.find((candidate) => candidate.source.installationId === admitted.installationId)
      if (!entry || (entry.source.kind !== 'npm' && entry.source.kind !== 'git')) continue
      const directory = leaseDirectory(store, admitted.installationId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const leasePath = path.join(directory, `${randomUUID()}.json`)
      await writeFile(leasePath, `${JSON.stringify({ canonicalPath: entry.source.canonicalPath })}\n`, { mode: 0o600 })
      leases.push({ installationId: admitted.installationId, leasePath })
    }
  } catch (error) {
    await Promise.all(leases.map((lease) => unlink(lease.leasePath).catch(() => undefined)))
    throw error
  }
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      for (const lease of leases) {
        await unlink(lease.leasePath).catch(() => undefined)
        await cleanupManagedInstallation(store, lease.installationId)
        const configured = (await store.read()).sources.find((source) => source.installationId === lease.installationId)
        if (configured?.resolvedSource) {
          await cleanupManagedRevisions(store, lease.installationId, configured.resolvedSource.canonicalPath)
        }
      }
    },
  }
}

export async function deferManagedInstallationRemoval(
  store: ExtensionConfigurationStore,
  installationId: string,
): Promise<void> {
  const installationRoot = path.join(store.packagesPath, installationId)
  if (!await isDirectory(installationRoot)) return
  await writeFile(path.join(installationRoot, REMOVAL_MARKER), 'pending\n', { mode: 0o600 })
  await cleanupManagedInstallation(store, installationId)
}

export async function cleanupManagedRevisions(
  store: ExtensionConfigurationStore,
  installationId: string,
  currentCanonicalPath: string,
): Promise<void> {
  const revisionsRoot = path.join(store.packagesPath, installationId, 'revisions')
  const retainedPaths = new Set(await Promise.all(
    [currentCanonicalPath, ...await activeCanonicalPaths(store, installationId)].map(canonicalExistingPath),
  ))
  let revisions
  try { revisions = await readdir(revisionsRoot, { withFileTypes: true }) } catch { return }
  for (const revision of revisions) {
    if (!revision.isDirectory()) continue
    const revisionRoot = await canonicalExistingPath(path.join(revisionsRoot, revision.name))
    const retained = [...retainedPaths].some((candidate) => (
      isWithin(revisionRoot, candidate) || isWithin(candidate, revisionRoot)
    ))
    if (!retained) await rm(path.join(revisionsRoot, revision.name), { recursive: true, force: true })
  }
}

async function cleanupManagedInstallation(store: ExtensionConfigurationStore, installationId: string): Promise<void> {
  const installationRoot = path.join(store.packagesPath, installationId)
  if (!await isFile(path.join(installationRoot, REMOVAL_MARKER))) return
  if ((await activeCanonicalPaths(store, installationId)).length > 0) return
  await rm(installationRoot, { recursive: true, force: true })
  await rm(leaseDirectory(store, installationId), { recursive: true, force: true }).catch(() => undefined)
}

async function activeCanonicalPaths(store: ExtensionConfigurationStore, installationId: string): Promise<string[]> {
  const directory = leaseDirectory(store, installationId)
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return [] }
  const paths: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const value = JSON.parse(await readFile(path.join(directory, entry.name), 'utf8')) as { canonicalPath?: unknown }
      if (typeof value.canonicalPath === 'string') paths.push(normalizePath(value.canonicalPath))
    } catch {
      // A malformed lease is retained conservatively until manually removed.
      paths.push(normalizePath(path.join(store.packagesPath, installationId)))
    }
  }
  return paths
}

function leaseDirectory(store: ExtensionConfigurationStore, installationId: string): string {
  return path.join(store.packagesPath, '.leases', installationId)
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/')
}

async function canonicalExistingPath(value: string): Promise<string> {
  try { return normalizePath(await realpath(value)) } catch { return normalizePath(path.resolve(value)) }
}

async function isFile(value: string): Promise<boolean> {
  try { return (await stat(value)).isFile() } catch { return false }
}

async function isDirectory(value: string): Promise<boolean> {
  try { return (await stat(value)).isDirectory() } catch { return false }
}
