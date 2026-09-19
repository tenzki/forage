import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, readdir, realpath, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  extensionSourceRequestSchema,
  extensionSourceSchema,
  type ExtensionCatalogEntry,
  type ExtensionDiagnostic,
  type ExtensionSource,
  type ExtensionSourceConfiguration,
  type ExtensionSourceRequest,
} from '@forage/agent-runtime'
import { ExtensionConfigurationStore, canonicalizeExtensionDirectory } from './configuration'
import { inspectExtensionSource } from './inventory'
import { cleanupManagedRevisions, deferManagedInstallationRemoval } from './leases'

const COMMAND_OUTPUT_LIMIT = 64_000
const COMMAND_TIMEOUT_MS = 120_000
const INSTALL_SCRIPT_NAMES = ['preinstall', 'install', 'postinstall'] as const

export interface PackageCommandResult {
  stdout: string
  stderr: string
}

export interface PackageCommandRunner {
  run(command: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }): Promise<PackageCommandResult>
}

export interface PackageLifecycleValidator {
  (entry: ExtensionCatalogEntry, configuration: ExtensionSourceConfiguration, signal: AbortSignal): Promise<ExtensionDiagnostic[]>
}

export interface ExtensionInstallPreview {
  previewId: string
  requestedSource: ExtensionSourceRequest
  entry: ExtensionCatalogEntry
}

interface StagedSource {
  previewId: string
  requestedSource: ExtensionSourceRequest
  source: ExtensionSource
  stageRoot?: string
  sourceRelativePath?: string
  revision: string
  installable?: boolean
}

export interface PackageLifecycleOptions {
  store: ExtensionConfigurationStore
  validateEntry: PackageLifecycleValidator
  commandRunner?: PackageCommandRunner
  createId?: (prefix: string) => string
}

export class ExtensionPackageLifecycle {
  private readonly runner: PackageCommandRunner
  private readonly createId: (prefix: string) => string
  private readonly previews = new Map<string, StagedSource>()

  constructor(private readonly options: PackageLifecycleOptions) {
    this.runner = options.commandRunner ?? new SpawnPackageCommandRunner()
    this.createId = options.createId ?? ((prefix) => `${prefix}-${randomUUID()}`)
  }

  async preview(rawSource: ExtensionSourceRequest): Promise<ExtensionInstallPreview> {
    const requestedSource = extensionSourceRequestSchema.parse(rawSource)
    const staged = requestedSource.kind === 'local'
      ? await this.stageLocal(requestedSource)
      : requestedSource.kind === 'npm'
        ? await this.stageNpm(requestedSource)
        : await this.stageGit(requestedSource)
    try {
      const entry = await inspectExtensionSource(staged.source)
      if (!entry.manifest && !entry.inspection) {
        throw new Error(entry.diagnostics[0]?.message ?? 'The source is not a compatible Forage extension.')
      }
      if (requestedSource.kind !== 'local' && entry.manifest && entry.status !== 'error') {
        await this.validateEntrySyntax(entry)
      }
      staged.installable = Boolean(entry.manifest && entry.status !== 'error' && entry.status !== 'incompatible')
      this.previews.set(staged.previewId, staged)
      return { previewId: staged.previewId, requestedSource, entry }
    } catch (error) {
      await this.discard(staged)
      throw error
    }
  }

  async install(rawSource: ExtensionSourceRequest, previewId?: string): Promise<string> {
    const requestedSource = extensionSourceRequestSchema.parse(rawSource)
    let staged = previewId ? this.previews.get(previewId) : undefined
    if (staged && JSON.stringify(staged.requestedSource) !== JSON.stringify(requestedSource)) {
      throw new Error('The install source no longer matches its preview.')
    }
    if (!staged) {
      const preview = await this.preview(requestedSource)
      staged = this.previews.get(preview.previewId)
    }
    if (!staged) throw new Error('The staged extension preview is no longer available.')
    if (!staged.installable) throw new Error('The previewed source is not installable; review its diagnostics.')
    this.previews.delete(staged.previewId)

    if (requestedSource.kind === 'local') {
      const registration = await this.options.store.registerLocalSource(requestedSource.path)
      return registration.installationId
    }

    const existing = (await this.options.store.read()).sources.find((source) => (
      source.source.kind === requestedSource.kind
      && JSON.stringify(source.source) === JSON.stringify(requestedSource)
    ))
    if (existing) {
      await this.discard(staged)
      return existing.installationId
    }

    const installationId = this.createId('managed')
    const revisionDirectory = `${safeSegment(staged.revision)}-${randomUUID()}`
    const finalRoot = path.join(this.options.store.packagesPath, installationId, 'revisions', revisionDirectory)
    await mkdir(path.dirname(finalRoot), { recursive: true, mode: 0o700 })
    try {
      await rename(staged.stageRoot!, finalRoot)
      const canonicalPath = normalizePath(path.join(finalRoot, staged.sourceRelativePath!))
      const resolvedSource = requestedSource.kind === 'npm'
        ? extensionSourceSchema.parse({
          kind: 'npm', installationId, spec: requestedSource.spec,
          resolvedVersion: staged.revision, canonicalPath,
        })
        : extensionSourceSchema.parse({
          kind: 'git', installationId, url: requestedSource.url,
          ...(requestedSource.ref ? { requestedRef: requestedSource.ref } : {}),
          resolvedCommit: staged.revision, canonicalPath,
        })
      await this.options.store.mutate((draft) => {
        draft.sources.push({
          installationId,
          source: requestedSource,
          resolvedSource,
          enabled: false,
          trust: { accepted: false },
          settings: {},
        })
      })
      return installationId
    } catch (error) {
      await rm(path.join(this.options.store.packagesPath, installationId), { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async checkForUpdate(configuration: ExtensionSourceConfiguration): Promise<{ available: boolean; revision?: string }> {
    if (!configuration.resolvedSource) throw new Error('The managed extension has no installed revision.')
    if (configuration.source.kind === 'npm') {
      if (isExactNpmVersion(configuration.source.spec)) return { available: false, revision: configuration.resolvedSource.kind === 'npm' ? configuration.resolvedSource.resolvedVersion : undefined }
      const metadata = await this.npmMetadata(configuration.source.spec)
      const current = configuration.resolvedSource.kind === 'npm' ? configuration.resolvedSource.resolvedVersion : ''
      return { available: metadata.version !== current, revision: metadata.version }
    }
    if (configuration.source.kind === 'git') {
      if (configuration.source.ref) return { available: false, revision: configuration.resolvedSource.kind === 'git' ? configuration.resolvedSource.resolvedCommit : undefined }
      const result = await this.command('git', ['ls-remote', configuration.source.url, 'HEAD'])
      const revision = result.stdout.trim().split(/\s+/u)[0]
      if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error('Git did not return a valid remote HEAD commit.')
      const current = configuration.resolvedSource.kind === 'git' ? configuration.resolvedSource.resolvedCommit : ''
      return { available: revision.toLowerCase() !== current.toLowerCase(), revision: revision.toLowerCase() }
    }
    return { available: false }
  }

  async update(configuration: ExtensionSourceConfiguration): Promise<string> {
    if (configuration.source.kind === 'local') throw new Error('Local extension directories use Reload instead of Update.')
    const update = await this.checkForUpdate(configuration)
    if (!update.available) return configuration.installationId
    const staged = configuration.source.kind === 'npm'
      ? await this.stageNpm(configuration.source)
      : await this.stageGit(configuration.source)
    let promotedRoot: string | undefined
    try {
      const entry = await inspectExtensionSource(staged.source)
      if (!entry.manifest || entry.status === 'error' || entry.status === 'incompatible') {
        throw new Error(entry.diagnostics[0]?.message ?? 'The update is not a compatible Forage extension.')
      }
      if (configuration.trust.accepted && configuration.trust.extensionId !== entry.manifest.id) {
        throw new Error('The update changed the extension identity accepted for this installation.')
      }
      await this.validateEntrySyntax(entry)
      await this.validateStagedEntry(entry)
      const revisionDirectory = `${safeSegment(staged.revision)}-${randomUUID()}`
      const finalRoot = path.join(this.options.store.packagesPath, configuration.installationId, 'revisions', revisionDirectory)
      await mkdir(path.dirname(finalRoot), { recursive: true, mode: 0o700 })
      await rename(staged.stageRoot!, finalRoot)
      promotedRoot = finalRoot
      const canonicalPath = normalizePath(path.join(finalRoot, staged.sourceRelativePath!))
      const requestedSource = configuration.source
      await this.options.store.mutate((draft) => {
        const source = draft.sources.find((candidate) => candidate.installationId === configuration.installationId)
        if (!source) throw new Error(`Unknown extension installation: ${configuration.installationId}`)
        source.resolvedSource = requestedSource.kind === 'npm'
          ? extensionSourceSchema.parse({
            kind: 'npm', installationId: configuration.installationId, spec: requestedSource.spec,
            resolvedVersion: staged.revision, canonicalPath,
          })
          : extensionSourceSchema.parse({
            kind: 'git', installationId: configuration.installationId, url: requestedSource.url,
            ...(requestedSource.ref ? { requestedRef: requestedSource.ref } : {}),
            resolvedCommit: staged.revision, canonicalPath,
          })
      })
      await cleanupManagedRevisions(this.options.store, configuration.installationId, canonicalPath).catch(() => undefined)
      return configuration.installationId
    } catch (error) {
      await this.discard(staged)
      if (promotedRoot) await rm(promotedRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async remove(configuration: ExtensionSourceConfiguration): Promise<void> {
    await this.options.store.mutate((draft) => {
      draft.sources = draft.sources.filter((candidate) => candidate.installationId !== configuration.installationId)
    })
    if (configuration.source.kind !== 'local') {
      await deferManagedInstallationRemoval(this.options.store, configuration.installationId)
    }
  }

  private async stageLocal(source: Extract<ExtensionSourceRequest, { kind: 'local' }>): Promise<StagedSource> {
    const canonicalPath = await canonicalizeExtensionDirectory(this.options.store.root, source.path)
    const previewId = this.createId('preview')
    return {
      previewId,
      requestedSource: source,
      source: extensionSourceSchema.parse({ kind: 'local', installationId: previewId, requestedPath: source.path, canonicalPath }),
      revision: 'local',
    }
  }

  private async stageNpm(source: Extract<ExtensionSourceRequest, { kind: 'npm' }>): Promise<StagedSource> {
    const metadata = await this.npmMetadata(source.spec)
    const previewId = this.createId('preview')
    const stageRoot = await this.createStage(previewId)
    try {
      await writeFile(path.join(stageRoot, 'package.json'), '{"private":true}\n', { encoding: 'utf8', mode: 0o600 })
      await this.command('npm', [
        'install', normalizeNpmSpec(source.spec), '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
      ], { cwd: stageRoot })
      await assertNoInstallScripts(stageRoot)
      const sourceRelativePath = path.join('node_modules', ...metadata.name.split('/'))
      const canonicalPath = normalizePath(await realpath(path.join(stageRoot, sourceRelativePath)))
      return {
        previewId, requestedSource: source,
        source: extensionSourceSchema.parse({ kind: 'npm', installationId: previewId, spec: source.spec, resolvedVersion: metadata.version, canonicalPath }),
        stageRoot, sourceRelativePath, revision: metadata.version,
      }
    } catch (error) {
      await rm(stageRoot, { recursive: true, force: true })
      throw error
    }
  }

  private async stageGit(source: Extract<ExtensionSourceRequest, { kind: 'git' }>): Promise<StagedSource> {
    const previewId = this.createId('preview')
    const stageRoot = await this.createStage(previewId)
    const sourceRelativePath = 'source'
    const sourceRoot = path.join(stageRoot, sourceRelativePath)
    try {
      await this.command('git', ['clone', '--no-checkout', source.url, sourceRoot])
      await this.command('git', ['checkout', '--detach', source.ref ?? 'HEAD'], { cwd: sourceRoot })
      const revisionResult = await this.command('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot })
      const revision = revisionResult.stdout.trim().toLowerCase()
      if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Git did not resolve a valid commit.')
      if (await isFile(path.join(sourceRoot, 'package.json'))) {
        await this.command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], { cwd: sourceRoot })
        await assertNoInstallScripts(sourceRoot)
      }
      const canonicalPath = normalizePath(await realpath(sourceRoot))
      return {
        previewId, requestedSource: source,
        source: extensionSourceSchema.parse({
          kind: 'git', installationId: previewId, url: source.url,
          ...(source.ref ? { requestedRef: source.ref } : {}), resolvedCommit: revision, canonicalPath,
        }),
        stageRoot, sourceRelativePath, revision,
      }
    } catch (error) {
      await rm(stageRoot, { recursive: true, force: true })
      throw error
    }
  }

  private async validateStagedEntry(entry: ExtensionCatalogEntry): Promise<void> {
    const controller = new AbortController()
    const configuration: ExtensionSourceConfiguration = {
      installationId: entry.source.installationId,
      source: entry.source.kind === 'npm'
        ? { kind: 'npm', spec: entry.source.spec }
        : { kind: 'git', url: entry.source.kind === 'git' ? entry.source.url : '', ...(entry.source.kind === 'git' && entry.source.requestedRef ? { ref: entry.source.requestedRef } : {}) },
      resolvedSource: entry.source,
      enabled: true,
      trust: { accepted: true, extensionId: entry.manifest!.id },
      settings: {},
    }
    const diagnostics = await this.options.validateEntry(entry, configuration, controller.signal)
    const error = diagnostics.find((item) => item.severity === 'error')
    if (error) throw new Error(`Extension entry validation failed: ${error.message}`)
  }

  private async validateEntrySyntax(entry: ExtensionCatalogEntry): Promise<void> {
    if (!entry.manifest) throw new Error('A compatible manifest is required for entry validation.')
    const entryPath = path.resolve(entry.source.canonicalPath, entry.manifest.entry.slice(2))
    await this.command(process.execPath, ['--check', entryPath])
  }

  private async npmMetadata(spec: string): Promise<{ name: string; version: string }> {
    const result = await this.command('npm', ['view', normalizeNpmSpec(spec), 'name', 'version', '--json'])
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch { throw new Error('npm returned invalid package metadata.') }
    const value = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed
    if (!value || typeof value !== 'object') throw new Error('npm did not resolve the package specification.')
    const { name, version } = value as Record<string, unknown>
    if (typeof name !== 'string' || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error('npm returned invalid package identity or version metadata.')
    }
    return { name, version }
  }

  private async createStage(previewId: string): Promise<string> {
    const stagingRoot = path.join(this.options.store.packagesPath, '.staging')
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
    const stageRoot = path.join(stagingRoot, previewId)
    await mkdir(stageRoot, { mode: 0o700 })
    return stageRoot
  }

  private async command(command: string, args: readonly string[], options?: { cwd?: string }): Promise<PackageCommandResult> {
    try {
      return await this.runner.run(command, args, options)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new Error(`Required executable “${command}” is not available. Install it and try again.`)
      }
      throw error
    }
  }

  private async discard(staged: StagedSource): Promise<void> {
    if (staged.stageRoot) await rm(staged.stageRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export class SpawnPackageCommandRunner implements PackageCommandRunner {
  run(command: string, args: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<PackageCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { cwd: options.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let exceeded = false
      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString('utf8')
        if (next.length > COMMAND_OUTPUT_LIMIT) exceeded = true
        return next.slice(0, COMMAND_OUTPUT_LIMIT)
      }
      child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
      child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
      child.once('error', reject)
      const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? COMMAND_TIMEOUT_MS)
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        if (exceeded) return reject(new Error(`${command} output exceeded the safety limit.`))
        if (code !== 0) return reject(new Error(`${command} failed${signal ? ` (${signal})` : ''}: ${(stderr || stdout).trim().slice(0, 2_000) || `exit ${code}`}`))
        resolve({ stdout, stderr })
      })
    })
  }
}

export function normalizeNpmSpec(spec: string): string {
  return spec.startsWith('npm:') ? spec.slice(4) : spec
}

export function isExactNpmVersion(spec: string): boolean {
  const normalized = normalizeNpmSpec(spec)
  const separator = normalized.startsWith('@') ? normalized.indexOf('@', normalized.indexOf('/') + 1) : normalized.lastIndexOf('@')
  return separator > 0 && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized.slice(separator + 1))
}

async function assertNoInstallScripts(root: string): Promise<void> {
  await assertPackageHasNoInstallScripts(root, path.join(root, 'package.json'))
  const nodeModules = path.join(root, 'node_modules')
  if (!await isDirectory(nodeModules)) return
  const queue = [nodeModules]
  let inspected = 0
  while (queue.length) {
    const directory = queue.shift()!
    if (++inspected > 20_000) throw new Error('Installed dependency tree exceeds the inspection limit.')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(entryPath)
      else if (entry.isFile() && entry.name === 'package.json') {
        await assertPackageHasNoInstallScripts(root, entryPath)
      }
    }
  }
}

async function assertPackageHasNoInstallScripts(root: string, packageJsonPath: string): Promise<void> {
  let packageJson: unknown
  try { packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) } catch { return }
  const scripts = packageJson && typeof packageJson === 'object' && !Array.isArray(packageJson)
    ? (packageJson as { scripts?: unknown }).scripts : undefined
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return
  const required = INSTALL_SCRIPT_NAMES.filter((name) => typeof (scripts as Record<string, unknown>)[name] === 'string')
  if (required.length) {
    throw new Error(`Package ${normalizePath(path.relative(root, path.dirname(packageJsonPath))) || '.'} declares unsupported lifecycle script(s): ${required.join(', ')}. Forage v1 never runs dependency lifecycle scripts.`)
  }
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 80) || 'revision'
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/')
}

async function isFile(value: string): Promise<boolean> {
  try { return (await stat(value)).isFile() } catch { return false }
}

async function isDirectory(value: string): Promise<boolean> {
  try { return (await stat(value)).isDirectory() } catch { return false }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
