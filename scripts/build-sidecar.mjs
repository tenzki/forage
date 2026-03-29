/**
 * Build script for the Node.js AI sidecar binary.
 *
 * Steps:
 * 1. Run esbuild to bundle src-sidecar/index.ts → src-sidecar/dist/bundle.cjs
 * 2. Patch dynamic import() calls → Promise.resolve(require()) for pkg compatibility
 * 3. Use @yao-pkg/pkg to package into a self-contained binary at
 *    src-tauri/binaries/ai-sidecar-{arch}-{os}
 *
 * Usage:
 *   npm run build:sidecar
 *
 * Requirements:
 *   - @yao-pkg/pkg must be installed globally: npm install -g @yao-pkg/pkg
 *   - esbuild is available in the root node_modules (./node_modules/.bin/esbuild)
 */

import { execSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SIDECAR_DIR = join(ROOT, 'src-sidecar')
const BUNDLE_PATH = join(SIDECAR_DIR, 'dist', 'bundle.cjs')
const BINARIES_DIR = join(ROOT, 'src-tauri', 'binaries')

// Determine target triple for this platform
function getTargetTriple() {
  const arch = os.arch()
  const platform = os.platform()

  if (platform === 'darwin') {
    return arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin'
  }
  if (platform === 'linux') {
    return arch === 'arm64'
      ? 'aarch64-unknown-linux-gnu'
      : 'x86_64-unknown-linux-gnu'
  }
  if (platform === 'win32') {
    return 'x86_64-pc-windows-msvc'
  }
  throw new Error(`Unsupported platform: ${platform} ${arch}`)
}

// Determine pkg target for this platform
function getPkgTarget() {
  const arch = os.arch()
  const platform = os.platform()

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'node20-macos-arm64' : 'node20-macos-x64'
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'node20-linux-arm64' : 'node20-linux-x64'
  }
  if (platform === 'win32') {
    return 'node20-win-x64'
  }
  throw new Error(`Unsupported platform: ${platform} ${arch}`)
}

const triple = getTargetTriple()
const pkgTarget = getPkgTarget()
const outputPath = join(BINARIES_DIR, `ai-sidecar-${triple}`)

console.log(`Building sidecar binary for ${triple}...`)

// Step 1: Bundle with esbuild
console.log('Step 1: Bundling with esbuild...')
const esbuildBin = join(ROOT, 'node_modules', '.bin', 'esbuild')
if (!existsSync(esbuildBin)) {
  throw new Error(`esbuild not found at ${esbuildBin}. Run npm install in the root directory.`)
}

const esbuildResult = spawnSync(esbuildBin, [
  join(SIDECAR_DIR, 'index.ts'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${BUNDLE_PATH}`,
  '--target=node20',
], { stdio: 'inherit', cwd: SIDECAR_DIR })

if (esbuildResult.status !== 0) {
  throw new Error(`esbuild failed with exit code ${esbuildResult.status}`)
}

// Step 2: Patch dynamic imports for pkg compatibility
// @mariozechner/pi-ai uses (specifier) => import(specifier) to avoid breaking browser builds.
// In a bundled CJS context, require() is equivalent and pkg can handle it.
console.log('Step 2: Patching dynamic import() calls...')
let bundle = readFileSync(BUNDLE_PATH, 'utf8')

// Replace: (specifier) => import(specifier) with (specifier) => Promise.resolve(require(specifier))
bundle = bundle.replace(
  /\(specifier\) => import\(specifier\)/g,
  '(specifier) => Promise.resolve(require(specifier))'
)

// Replace: await import("crypto") with require("crypto")
bundle = bundle.replace(/await import\("crypto"\)/g, 'require("crypto")')

writeFileSync(BUNDLE_PATH, bundle)
console.log(`  Bundle written to ${BUNDLE_PATH}`)

// Step 3: Package with pkg
console.log(`Step 3: Packaging with pkg (target: ${pkgTarget})...`)

// Check if pkg is available
const pkgCheck = spawnSync('pkg', ['--version'], { stdio: 'pipe' })
if (pkgCheck.status !== 0) {
  throw new Error(
    'pkg not found. Install it globally: npm install -g @yao-pkg/pkg'
  )
}

const pkgResult = spawnSync('pkg', [
  BUNDLE_PATH,
  '--target', pkgTarget,
  '--output', outputPath,
], { stdio: 'inherit' })

if (pkgResult.status !== 0) {
  throw new Error(`pkg failed with exit code ${pkgResult.status}`)
}

console.log(`\nSidecar binary built successfully: ${outputPath}`)
