// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CliError, databaseUrl, readEnvironment, runCli } from './cli'

const tokensSchema = z.object({ DATABASE_URL: databaseUrl })
const bootstrapSchema = z.object({ DATABASE_URL: databaseUrl, FORAGE_OWNER_EMAIL: z.string().email() })

function failure(schema: z.ZodType<unknown>, environment: NodeJS.ProcessEnv): string {
  try {
    readEnvironment(schema, environment)
  } catch (error) {
    if (error instanceof CliError) return error.message
    throw error
  }
  throw new Error('Expected the configuration to be rejected.')
}

describe('server CLI configuration', () => {
  it('asks only for the settings the command actually reads', () => {
    const message = failure(tokensSchema, {})
    expect(message).toContain('Missing: DATABASE_URL.')
    expect(message).toContain('DATABASE_URL=postgres://forage:forage@127.0.0.1:55437/forage_test')
    expect(message).not.toContain('FORAGE_INSTANCE_ID')
    expect(message).not.toContain('FORAGE_ASSET_DIR')
    expect(message).not.toContain('ZodError')
  })

  it('names every missing variable for a command that needs more than one', () => {
    const message = failure(bootstrapSchema, {})
    expect(message).toContain('Missing: DATABASE_URL, FORAGE_OWNER_EMAIL.')
    expect(message).toContain('FORAGE_OWNER_EMAIL=owner@example.invalid')
  })

  it('reports a present but unusable variable as invalid rather than missing', () => {
    const message = failure(tokensSchema, { DATABASE_URL: 'mysql://localhost/forage' })
    expect(message).toContain('Invalid DATABASE_URL')
    expect(message).not.toContain('Missing')
  })

  it('returns the parsed environment once it is complete', () => {
    const parsed = readEnvironment(tokensSchema, {
      DATABASE_URL: 'postgres://forage:forage@127.0.0.1:55437/forage_test',
      FORAGE_ASSET_DIR: 'ignored',
    })
    expect(parsed.DATABASE_URL).toContain('forage_test')
  })
})

describe('server CLI runner', () => {
  it('prints the message without a stack trace and fails the process', async () => {
    const written: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    const previousExitCode = process.exitCode
    try {
      await runCli(async () => { throw new CliError('This server already has an owner.') })
      expect(written.join('')).toBe('This server already has an owner.\n')
      expect(process.exitCode).toBe(1)
    } finally {
      write.mockRestore()
      process.exitCode = previousExitCode
    }
  })

  it('explains a refused database connection', async () => {
    const written: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    const previousExitCode = process.exitCode
    try {
      await runCli(async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:55437'), { code: 'ECONNREFUSED' })
      })
      expect(written.join('')).toContain('npm run dev:infra')
    } finally {
      write.mockRestore()
      process.exitCode = previousExitCode
    }
  })

  it('leaves the exit code alone when the body succeeds', async () => {
    const previousExitCode = process.exitCode
    await runCli(async () => undefined)
    expect(process.exitCode).toBe(previousExitCode)
  })
})
