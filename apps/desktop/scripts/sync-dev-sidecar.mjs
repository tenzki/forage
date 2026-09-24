// Tauri copies bundled resources into target/ only when its build script reruns,
// which a rebuilt sidecar does not trigger. Dev runs read the target copy, so
// refresh it after every sidecar build.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src-tauri/resources/pi/sidecar/dist/', import.meta.url))
const target = fileURLToPath(new URL('../src-tauri/target/debug/resources/pi/sidecar/dist/', import.meta.url))

if (!existsSync(source)) throw new Error(`Sidecar bundle is missing: ${source}`)
rmSync(target, { recursive: true, force: true })
cpSync(source, target, { recursive: true })
