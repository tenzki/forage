import { assertSupportedNodeVersion } from './config.js'

// Check before loading the server: its agent runtime needs a newer Node.js than the
// rest of the code, and an old one would otherwise fail somewhere inside the Pi SDK.
try {
  assertSupportedNodeVersion()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
await import('./serve.js')
