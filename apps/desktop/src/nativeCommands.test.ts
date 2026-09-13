import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = dirname(fileURLToPath(import.meta.url))
const libRs = join(sourceRoot, '..', 'src-tauri', 'src', 'lib.rs')

const invokePattern = /\binvoke(?:Native)?\s*(?:<[^>]*>)?\s*\(\s*'([a-z0-9_]+)'/g

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return []
    return [path]
  })
}

function invokedCommands(): Map<string, string[]> {
  const callers = new Map<string, string[]>()
  for (const file of sourceFiles(sourceRoot)) {
    const contents = readFileSync(file, 'utf8')
    for (const [, command] of contents.matchAll(invokePattern)) {
      callers.set(command, [...(callers.get(command) ?? []), file.slice(sourceRoot.length + 1)])
    }
  }
  return callers
}

function registeredCommands(): Set<string> {
  const contents = readFileSync(libRs, 'utf8')
  const block = /generate_handler!\[([^\]]*)\]/s.exec(contents)
  if (!block) throw new Error('lib.rs no longer contains a generate_handler! block.')
  return new Set([...block[1].matchAll(/(?:[a-z_]+::)?([a-z0-9_]+)\s*,/g)].map(([, name]) => name))
}

describe('native command names', () => {
  it('registers every command the frontend invokes', () => {
    const registered = registeredCommands()
    // Guards the parser itself: an empty or mis-parsed list would pass every assertion.
    expect(registered.size).toBeGreaterThan(20)

    const invoked = invokedCommands()
    expect(invoked.size).toBeGreaterThan(20)

    const missing = [...invoked]
      .filter(([command]) => !registered.has(command))
      .map(([command, files]) => `${command} (invoked from ${files.join(', ')})`)
    expect(missing).toEqual([])
  })
})
