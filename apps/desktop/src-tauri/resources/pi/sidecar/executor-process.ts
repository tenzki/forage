import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeExtensionExecutorProcess, credentialFreeExecutorEnvironment } from '@forage/extension-host'

export function createSidecarExtensionExecutorProcess(
  options: {
    validationDeadlineMs?: number
    preparationDeadlineMs?: number
    executionDeadlineMs?: number
    terminationGraceMs?: number
    environment?: NodeJS.ProcessEnv
  } = {},
): NodeExtensionExecutorProcess {
  const currentFile = fileURLToPath(import.meta.url)
  const directory = path.dirname(currentFile)
  const bundled = path.extname(currentFile) === '.mjs'
  return new NodeExtensionExecutorProcess({
    workerPath: path.join(directory, bundled ? 'executor-worker.mjs' : 'executor-worker.ts'),
    ...(bundled ? {} : { nodeArguments: ['--import', 'tsx'] }),
    cwd: directory,
    environment: options.environment ?? credentialFreeExecutorEnvironment(),
    validationDeadlineMs: options.validationDeadlineMs,
    preparationDeadlineMs: options.preparationDeadlineMs,
    executionDeadlineMs: options.executionDeadlineMs,
    terminationGraceMs: options.terminationGraceMs,
  })
}
