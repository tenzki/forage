import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  extensionConfigurationSchema,
  extensionInstallationIdSchema,
  extensionSecretReferenceSchema,
  type ExtensionConfiguration,
} from '@forage/agent-runtime'

export const FORAGE_CONFIGURATION_DIRECTORY = '.forage'
export const FORAGE_CONFIGURATION_FILE = 'settings.json'
export const FORAGE_EXTENSIONS_DIRECTORY = 'extensions'
export const FORAGE_PACKAGES_DIRECTORY = 'packages'

const mutationQueues = new Map<string, Promise<void>>()

export interface ConfigurationStoreOptions {
  root?: string
  createInstallationId?: () => string
}

export interface ConfigurationMutation<T> {
  configuration: ExtensionConfiguration
  result: T
}

export interface LocalSourceRegistration {
  configuration: ExtensionConfiguration
  installationId: string
  canonicalPath: string
  created: boolean
}

export class ExtensionConfigurationError extends Error {
  readonly code: 'invalid_configuration' | 'invalid_source'

  constructor(code: ExtensionConfigurationError['code'], message: string) {
    super(message)
    this.name = 'ExtensionConfigurationError'
    this.code = code
  }
}

export function forageConfigurationRoot(home = homedir()): string {
  return path.resolve(home, FORAGE_CONFIGURATION_DIRECTORY)
}

export function createExtensionSecretReference(installationId: string, settingKey: string): string {
  const reference = `forage-extension/${extensionInstallationIdSchema.parse(installationId)}/${settingKey}`
  return extensionSecretReferenceSchema.parse(reference)
}

export function resolveConfiguredPath(configurationRoot: string, configuredPath: string): string {
  return path.resolve(configurationRoot, configuredPath)
}

export async function canonicalizeExtensionDirectory(
  configurationRoot: string,
  configuredPath: string,
): Promise<string> {
  const resolved = resolveConfiguredPath(configurationRoot, configuredPath)
  try {
    const canonical = await realpath(resolved)
    const metadata = await stat(canonical)
    if (!metadata.isDirectory()) throw new Error('source is not a directory')
    return normalizeAbsolutePath(canonical)
  } catch {
    throw new ExtensionConfigurationError(
      'invalid_source',
      `Extension source is not a readable directory: ${configuredPath}`,
    )
  }
}

export class ExtensionConfigurationStore {
  readonly root: string
  readonly settingsPath: string
  readonly extensionsPath: string
  readonly packagesPath: string
  private readonly createInstallationId: () => string

  constructor(options: ConfigurationStoreOptions = {}) {
    this.root = path.resolve(options.root ?? forageConfigurationRoot())
    this.settingsPath = path.join(this.root, FORAGE_CONFIGURATION_FILE)
    this.extensionsPath = path.join(this.root, FORAGE_EXTENSIONS_DIRECTORY)
    this.packagesPath = path.join(this.root, FORAGE_PACKAGES_DIRECTORY)
    this.createInstallationId = options.createInstallationId ?? (() => `local-${randomUUID()}`)
  }

  async read(): Promise<ExtensionConfiguration> {
    let serialized: string
    try {
      serialized = await readFile(this.settingsPath, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return emptyConfiguration()
      throw error
    }

    try {
      return extensionConfigurationSchema.parse(JSON.parse(serialized) as unknown)
    } catch {
      throw new ExtensionConfigurationError(
        'invalid_configuration',
        `Forage extension configuration is invalid; the original file was preserved at ${this.settingsPath}`,
      )
    }
  }

  async mutate<T>(mutation: (draft: ExtensionConfiguration) => T | Promise<T>): Promise<ConfigurationMutation<T>> {
    return serializeMutation(this.settingsPath, async () => {
      const current = await this.read()
      const draft = structuredClone(current)
      const result = await mutation(draft)
      const configuration = extensionConfigurationSchema.parse({
        ...draft,
        version: 1,
        revision: current.revision + 1,
      })
      await this.writeAtomic(configuration)
      return { configuration, result }
    })
  }

  async registerLocalSource(configuredPath: string): Promise<LocalSourceRegistration> {
    const canonicalPath = await canonicalizeExtensionDirectory(this.root, configuredPath)
    const mutation = await this.mutate(async (draft) => {
      for (const source of draft.sources) {
        if (source.source.kind !== 'local') continue
        let existingCanonicalPath: string
        try {
          existingCanonicalPath = await canonicalizeExtensionDirectory(this.root, source.source.path)
        } catch {
          continue
        }
        if (existingCanonicalPath === canonicalPath) {
          return { installationId: source.installationId, created: false }
        }
      }

      const installationId = extensionInstallationIdSchema.parse(this.createInstallationId())
      draft.sources.push({
        installationId,
        source: { kind: 'local', path: configuredPath },
        enabled: false,
        trust: { accepted: false },
        settings: {},
      })
      return { installationId, created: true }
    })

    return { ...mutation.result, configuration: mutation.configuration, canonicalPath }
  }

  private async writeAtomic(configuration: ExtensionConfiguration): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await Promise.all([
      mkdir(this.extensionsPath, { recursive: true, mode: 0o700 }),
      mkdir(this.packagesPath, { recursive: true, mode: 0o700 }),
    ])
    const temporaryPath = path.join(this.root, `.${FORAGE_CONFIGURATION_FILE}.${randomUUID()}.tmp`)
    try {
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(configuration, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporaryPath, this.settingsPath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
    await syncDirectory(this.root)
  }
}

function emptyConfiguration(): ExtensionConfiguration {
  return { version: 1, revision: 0, sources: [] }
}

function normalizeAbsolutePath(value: string): string {
  return value.split(path.sep).join('/')
}

async function serializeMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const pending = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => pending)
  mutationQueues.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release?.()
    if (mutationQueues.get(key) === tail) mutationQueues.delete(key)
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    await access(directory, constants.R_OK)
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // The rename is still atomic on platforms that do not permit directory fsync.
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
