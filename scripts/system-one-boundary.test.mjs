import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const productionRoots = [
  'apps/desktop/src',
  'apps/desktop/src-tauri/resources/pi/sidecar',
  'apps/server/src',
  'packages/agent-runtime/src',
  'packages/extension-api/src',
  'packages/extension-host/src',
  'packages/protocol/src',
]
const sourceExtension = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u
const excludedFile = /(?:^|\/)(?:dist|node_modules|coverage)(?:\/|$)|(?:\.test|\.spec)\.[^.]+$/u
const forbidden = [
  { label: 'System One identity or type', pattern: /SystemOne|systemOne|system_one|system-one|dev\.forage\.system-one/gu },
  { label: 'Jev backend identity', pattern: /\bJev\b|\bjev\b/gu },
  { label: 'TypeSafe backend identity', pattern: /\bTypeSafe\b|\btypesafe\b/gu },
  { label: 'Noul domain type', pattern: /\bNoul\b|\bnoul\b/gu },
  { label: 'candidate-selection domain field', pattern: /candidateScope|candidate_scope/gu },
  { label: 'evaluation answer field', pattern: /yesProbability|yes_probability/gu },
  { label: 'abandoned provider registration', pattern: /registerSystemOneProvider/gu },
]

function filesUnder(relativeRoot) {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot)
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(repositoryRoot, absolute).split(path.sep).join('/')
      if (excludedFile.test(relative)) continue
      if (entry.isDirectory()) visit(absolute)
      else if (sourceExtension.test(entry.name)) files.push(relative)
    }
  }
  visit(absoluteRoot)
  return files
}

test('core production code contains no System One or Jev domain boundary leaks', () => {
  const violations = []
  for (const file of productionRoots.flatMap(filesUnder)) {
    const source = readFileSync(path.join(repositoryRoot, file), 'utf8')
    for (const rule of forbidden) {
      rule.pattern.lastIndex = 0
      if (rule.pattern.test(source)) violations.push(`${file}: ${rule.label}`)
    }
  }
  assert.deepEqual(violations, [])
})

test('the whole feature package is runtime-independent from core and core never depends on it', () => {
  const featureManifest = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'extensions/system-one/package.json'),
    'utf8',
  ))
  assert.deepEqual(featureManifest.dependencies, { '@forage/extension-api': 'workspace:*' })

  const coreManifests = [
    'apps/desktop/package.json',
    'apps/server/package.json',
    'packages/agent-runtime/package.json',
    'packages/extension-api/package.json',
    'packages/extension-host/package.json',
    'packages/protocol/package.json',
  ]
  for (const relative of coreManifests) {
    const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, relative), 'utf8'))
    const dependencyNames = Object.keys({
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    })
    assert.equal(
      dependencyNames.includes('@forage/extension-system-one'),
      false,
      `${relative} must not depend on the feature extension`,
    )
  }
})
