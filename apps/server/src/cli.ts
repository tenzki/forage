import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** Repo-root .env, so the workspace-scoped npm scripts run without an env prefix. */
const DOT_ENV_PATH = fileURLToPath(new URL('../../../.env', import.meta.url))

let dotEnvLoaded = false

/** Loads the repo-root .env once. Variables already set in the shell win. */
function loadDotEnv(): void {
  if (dotEnvLoaded) return
  dotEnvLoaded = true
  if (!existsSync(DOT_ENV_PATH)) return
  try {
    process.loadEnvFile(DOT_ENV_PATH)
  } catch (error) {
    throw new CliError(`Could not read ${DOT_ENV_PATH}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Values that satisfy the local development compose stack, shown only for variables a command actually needs. */
const LOCAL_DEVELOPMENT_ENVIRONMENT: Record<string, string> = {
  DATABASE_URL: 'postgres://forage:forage@127.0.0.1:55437/forage_test',
  FORAGE_INSTANCE_ID: 'local-development',
  FORAGE_ASSET_DIR: '../../.local/forage-assets',
  FORAGE_OWNER_EMAIL: 'owner@example.invalid',
}

export const databaseUrl = z.string().url().startsWith('postgres')

/** Ends a CLI run with an explanation rather than a stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

function sentence(value: string): string {
  const trimmed = value.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * Reads only the variables a command needs, so the report never demands settings
 * that command will not use. Coerced fields report a transformed input, so absence
 * is decided by the environment itself rather than by the issue. Passing an explicit
 * environment skips the .env load, which keeps tests off the real process environment.
 */
export function readEnvironment<T>(schema: z.ZodType<T>, environment?: NodeJS.ProcessEnv): T {
  if (!environment) loadDotEnv()
  const source = environment ?? process.env

  const parsed = schema.safeParse(source)
  if (parsed.success) return parsed.data

  const missing: string[] = []
  const invalid: Array<{ name: string; reason: string }> = []
  for (const issue of parsed.error.issues) {
    const name = String(issue.path[0] ?? 'configuration')
    if (source[name] === undefined) missing.push(name)
    else invalid.push({ name, reason: sentence(issue.message) })
  }

  const lines = ['This command cannot run with the current environment.', '']
  if (missing.length) lines.push(`Missing: ${missing.join(', ')}.`)
  for (const entry of invalid) lines.push(`Invalid ${entry.name}: ${entry.reason}`)

  const examples = [...missing, ...invalid.map((entry) => entry.name)]
    .filter((name) => LOCAL_DEVELOPMENT_ENVIRONMENT[name])
  if (examples.length) {
    lines.push('', 'Local development values:')
    for (const name of examples) lines.push(`  ${name}=${LOCAL_DEVELOPMENT_ENVIRONMENT[name]}`)
    lines.push('', `Put them in ${DOT_ENV_PATH}, or pass them on the command line.`)
  }
  throw new CliError(lines.join('\n'))
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof CliError) return message
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return [
      `Could not reach PostgreSQL: ${message}`,
      'Start the local database first with: npm run dev:infra',
    ].join('\n')
  }
  return message
}

/** Runs a CLI body, reporting CliError and thrown Error messages without a stack trace. */
export async function runCli(main: () => Promise<void>): Promise<void> {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${describeFailure(error)}\n`)
    process.exitCode = 1
  }
}
