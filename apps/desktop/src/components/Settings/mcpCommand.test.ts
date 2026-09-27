import { describe, expect, it } from 'vitest'
import { parseMcpCommand } from './mcpCommand'

describe('MCP launch commands', () => {
  it('preserves quoted arguments, escaped spaces, and empty arguments', () => {
    expect(parseMcpCommand('"/My Tools/node" server.mjs --folder My\\ Files --label \'A "quoted" label\' ""')).toEqual({
      command: '/My Tools/node', args: ['server.mjs', '--folder', 'My Files', '--label', 'A "quoted" label', ''],
    })
  })
  it('preserves literal special characters when quoted or escaped', () => {
    expect(parseMcpCommand('node server.mjs \'$literal\' "https://example.com?a=b&c=d" \\$escaped')).toEqual({
      command: 'node', args: ['server.mjs', '$literal', 'https://example.com?a=b&c=d', '$escaped'],
    })
  })
  it.each(['npx server && echo done', 'node $SERVER', 'node "$(command)"', 'node `command`', 'node server > log', 'TOKEN=secret node server', 'node ~/server', 'node *.mjs', 'node server\nnode other'])('rejects shell-only syntax: %s', (command) => {
    expect(() => parseMcpCommand(command)).toThrow(/shell|environment/)
  })
  it.each(['', 'node "unclosed', 'node incomplete\\'])('rejects incomplete commands: %s', (command) => {
    expect(() => parseMcpCommand(command)).toThrow()
  })
})
