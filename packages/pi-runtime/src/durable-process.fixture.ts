import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { createFileConversationStore } from './conversation-store'
import { runPiTurn, RunSuspended } from './run-turn'
import { scriptedModel } from './scripted-model.test-support'

const [directory, scenario, phase] = process.argv.slice(2)
const id = scenario === 'unsafe' ? 'http_write' : scenario === 'images' ? 'generate_image' : 'web_read'
const images = new Map<string, { src: string; prompt: string }>()
const imageId = `img_${'a'.repeat(32)}`
const suspension = new AbortController()
if (scenario === 'suspend') process.on('SIGTERM', () => suspension.abort())
const emit = fauxAssistantMessage(fauxToolCall('emit_outline', {
  nodes: scenario === 'images' ? [{ imageId }] : [{ text: 'Recovered.' }], sources: [{ url: 'https://example.com/evidence', label: 'Evidence' }],
}))
const model = await scriptedModel(phase === 'recover' ? (scenario === 'budget' ? [fauxAssistantMessage(fauxToolCall(id, {})), emit] : [emit]) : [
  fauxAssistantMessage(fauxToolCall(id, {})),
  async () => { process.stdout.write('checkpoint\n'); return await new Promise<never>(() => undefined) },
])
try {
  const outcome = await runPiTurn({
    runId: 'run-1', executionMode: 'server', instructions: [], prompt: 'Research.', context: [],
    thread: { callId: 'call-1', turn: 1 }, effectiveToolIds: [id], requiredToolIds: [],
  }, {
    ...model,
    beforeRun: async () => { appendFileSync(join(directory, 'hooks'), 'start\n') },
    afterRun: async () => { appendFileSync(join(directory, 'hooks'), 'end\n') },
    conversation: createFileConversationStore(directory), images,
    runtimeTools: [{ id, name: id, description: 'Fixture tool', execute: async () => {
      appendFileSync(join(directory, 'effects'), 'effect\n')
      if (scenario !== 'completed' && scenario !== 'images' && scenario !== 'budget' && scenario !== 'suspend' && phase !== 'recover') {
        process.stdout.write('checkpoint\n')
        await new Promise<never>(() => undefined)
      }
      if (scenario === 'images') images.set(imageId, { src: 'data:image/png;base64,cached-image', prompt: 'Saved image' })
      return { trust: 'untrusted', sourceType: 'webpage', canonicalUrl: 'https://example.com/evidence', content: 'Evidence.' }
    } }],
  }, { maxToolRounds: scenario === 'budget' ? 2 : undefined, suspendSignal: suspension.signal })
  process.stdout.write(JSON.stringify(outcome) + '\n')
} catch (error) {
  if (error instanceof RunSuspended) { process.stdout.write('suspended\n') }
  else if (scenario !== 'budget') throw error
  else process.stdout.write(JSON.stringify({ error: (error as { code: string }).code }) + '\n')
}
