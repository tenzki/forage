/** Split a launch command into literal argv. It is never evaluated by a shell. */
export function parseMcpCommand(value: string): { command: string; args: string[] } {
  const words: string[] = []
  let word = ''
  let started = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (char === quote) { quote = null; continue }
    if (quote === "'") { word += char; continue }
    if (char === '\\') {
      const next = value[++i]
      if (next === undefined) throw new Error('The command ends with an incomplete escape.')
      // Double quotes only escape quote, backslash, and shell interpolation markers.
      word += quote === '"' && !['"', '\\', '$', '`'].includes(next) ? `\\${next}` : next
      started = true
      continue
    }
    if (char === '$' || char === '`' || (!quote && /[|&;<>()*?~\r\n]/.test(char))) {
      throw new Error('Use a single launch command with literal arguments. Add environment variables below; shell operators and expansion are not supported.')
    }
    if (!quote && (char === "'" || char === '"')) { quote = char; started = true; continue }
    if (!quote && /\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false }
    } else { word += char; started = true }
  }
  if (quote) throw new Error('Close the quotation mark in the launch command.')
  if (started) words.push(word)
  const command = words.shift()
  if (!command) throw new Error('Enter the server’s launch command.')
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command)) throw new Error('Add environment variables below the command.')
  return { command, args: words }
}
