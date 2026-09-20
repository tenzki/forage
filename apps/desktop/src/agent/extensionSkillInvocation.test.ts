import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { ExtensionCatalog, ExtensionConfiguration, ExtensionSkillDefinition } from '@forage/agent-runtime'
import { BulletAttributes } from '../editor/extensions'
import { InternalLink } from '../editor/internalLinks'
import type { ExtensionExecutorBridge, PreparedExtensionExecutorAdmission } from './extensionExecutorClient'
import {
  assertExtensionExecutionLocation,
  executePreparedExtensionSkill,
  prepareExtensionSkillInvocation,
  retainPreparedExtensionSkillResult,
  selectedExtensionExecutor,
} from './extensionSkillInvocation'

const skill: ExtensionSkillDefinition = {
  id: 'label-skill', label: 'label-skill', description: 'Label notes', execution: 'extension',
  executor: { extensionId: 'dev.example.notes', executorId: 'label_notes' }, configuration: { contains: 'match' },
}
const manifest = {
  id: 'dev.example.notes', name: 'Notes', version: '1.0.0', description: 'Generic notes fixture.', entry: './index.js',
  contributes: { tools: [], hooks: [], settings: [], executors: [{
    id: 'label_notes', name: 'Label notes', description: 'Label matching notes.', allowEmptyPrompt: true,
    configuration: { fields: [{ key: 'contains', label: 'Contains', type: 'text' as const, required: true }] },
  }] },
}
const catalog: ExtensionCatalog = {
  version: 1, revision: 'a'.repeat(64), entries: [{
    source: { kind: 'local', installationId: 'notes-install', requestedPath: '/notes', canonicalPath: '/notes' },
    manifest,
    provenance: { installationId: 'notes-install', extensionId: manifest.id, sourceKind: 'local', sourceRevision: 'source-1', entryDigest: 'b'.repeat(64) },
    status: 'ready', tools: [], executors: manifest.contributes.executors.map((executor) => ({ ...executor, available: true, diagnostics: [] })), diagnostics: [],
  }],
}
const configuration: ExtensionConfiguration = {
  version: 1, revision: 41, sources: [{
    installationId: 'notes-install', source: { kind: 'local', path: '/notes' }, enabled: true,
    trust: { accepted: true, extensionId: manifest.id }, settings: {}, secretReferences: {},
  }],
}

function editor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes, InternalLink],
    content: { type: 'doc', content: [{ type: 'bulletList', content: [{
      type: 'listItem', attrs: { nodeId: 'parent' }, content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Parent' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', attrs: { nodeId: 'candidate' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Match this' }] }] },
          { type: 'listItem', attrs: { nodeId: 'invocation' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '/label-skill' }] }] },
        ] },
      ],
    }] }] },
  })
}

describe('generic extension skill invocation', () => {
  let instance: Editor | null = null
  afterEach(() => instance?.destroy())

  it('admits an empty-prompt extension through the generic context path with independent revisions', async () => {
    instance = editor()
    const execute = vi.fn(async () => ({ nodes: [{ type: 'text' as const, segments: [{ type: 'text' as const, text: 'Prepared result' }] }] }))
    const release = vi.fn(async () => undefined)
    const admit = vi.fn(async (input): Promise<PreparedExtensionExecutorAdmission> => ({
      admissionId: 'admission', executorSnapshot: {
        version: 1, catalogRevision: catalog.revision, configurationRevision: configuration.revision,
        source: { installationId: 'notes-install', extensionId: manifest.id, sourceRevision: 'source-1', entryDigest: 'b'.repeat(64), executorId: 'label_notes' },
      },
      portableConfigurationRevision: input.portableConfigurationRevision,
      configuration: input.configuration,
      context: input.context,
      plan: { selectedNodeIds: ['candidate'], requestedReferenceIds: ['candidate'], admittedReferenceIds: ['candidate'], annotations: [{ nodeId: 'candidate', kind: 'selected', label: 'Matching note' }], data: {} },
      execute,
      release,
    }))
    const bridge: ExtensionExecutorBridge = { admit }

    const prepared = await prepareExtensionSkillInvocation({
      skill, prompt: '', doc: instance.state.doc, invocationNodeId: 'invocation', catalog,
      localConfiguration: configuration, portableConfigurationRevision: 7, runId: 'run-one', bridge,
    })

    expect(admit).toHaveBeenCalledWith(expect.objectContaining({
      portableConfigurationRevision: 7,
      hostAdmittedReferenceIds: ['parent', 'candidate'],
      context: expect.objectContaining({ prompt: '', provenance: expect.objectContaining({ localParentId: 'parent' }) }),
    }), expect.objectContaining({ signal: undefined }))
    expect(prepared.admission.executorSnapshot.configurationRevision).toBe(41)
    expect(prepared.admission.portableConfigurationRevision).toBe(7)
    await expect(executePreparedExtensionSkill(prepared, {})).resolves.toMatchObject({
      version: 2,
      nodes: [{ type: 'text' }],
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('fails unavailable and server execution before admission without desktop fallback', async () => {
    instance = editor()
    const bridge: ExtensionExecutorBridge = { admit: vi.fn() }
    expect(() => selectedExtensionExecutor({ ...skill, executor: { extensionId: 'dev.example.missing', executorId: 'missing' } }, catalog)).toThrow(/not installed/i)
    expect(() => assertExtensionExecutionLocation('server')).toThrow(/cannot run in server mode/i)
    await expect(prepareExtensionSkillInvocation({
      skill: { ...skill, executor: { extensionId: 'dev.example.missing', executorId: 'missing' } },
      prompt: '', doc: instance.state.doc, invocationNodeId: 'invocation', catalog,
      localConfiguration: configuration, portableConfigurationRevision: 1, runId: 'run-two', bridge,
    })).rejects.toThrow(/not installed/i)
    expect(bridge.admit).not.toHaveBeenCalled()
  })

  it('durably retains a validated result before placement and records controlled failures', async () => {
    instance = editor()
    const execute = vi.fn(async (
      _secrets: Readonly<Record<string, string | undefined>> = {},
      callbacks?: Parameters<PreparedExtensionExecutorAdmission['execute']>[1],
    ) => {
      callbacks?.onProgress?.({ message: 'Working', completed: 1, total: 2 })
      return {
        nodes: [{
          type: 'text' as const,
          segments: [{ type: 'internal-reference' as const, nodeId: 'candidate', label: 'Candidate' }],
        }],
      }
    })
    const bridge: ExtensionExecutorBridge = { admit: vi.fn(async (input) => ({
      admissionId: 'admission-retained',
      executorSnapshot: {
        version: 1 as const, catalogRevision: catalog.revision, configurationRevision: configuration.revision,
        source: { installationId: 'notes-install', extensionId: manifest.id, sourceRevision: 'source-1', entryDigest: 'b'.repeat(64), executorId: 'label_notes' },
      },
      portableConfigurationRevision: input.portableConfigurationRevision,
      configuration: input.configuration,
      context: input.context,
      plan: { selectedNodeIds: ['candidate'], requestedReferenceIds: ['candidate'], admittedReferenceIds: ['candidate'], annotations: [], data: {} },
      execute,
      release: vi.fn(async () => undefined),
    })) }
    const prepared = await prepareExtensionSkillInvocation({
      skill, prompt: '', doc: instance.state.doc, invocationNodeId: 'invocation', catalog,
      localConfiguration: configuration, portableConfigurationRevision: 9, runId: 'run-retained', bridge,
    })
    const repository = {
      admitAgentRun: vi.fn(async () => undefined),
      beginAgentAttempt: vi.fn(async () => 1),
      settleAgentRun: vi.fn(async () => undefined),
      placeAgentRunResult: vi.fn(async () => undefined),
    }

    const onProgress = vi.fn()
    const result = await retainPreparedExtensionSkillResult(prepared, {
      repository, runId: 'run-retained', outlineId: 'outline-one', invocationNodeId: 'invocation',
      onProgress,
      now: () => '2026-09-20T10:00:00.000Z',
    })

    expect(result.version).toBe(2)
    expect(repository.admitAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      id: 'run-retained',
      snapshot: expect.objectContaining({
        version: 2,
        configurationRevision: 9,
        localExecutorSnapshot: expect.objectContaining({ configurationRevision: 41 }),
      }),
    }))
    expect(repository.settleAgentRun).toHaveBeenCalledWith(
      'run-retained', 'completed_unplaced', 'result:run-retained', result, null,
      '2026-09-20T10:00:00.000Z',
    )
    expect(repository.placeAgentRunResult).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalledWith({ message: 'Working', completed: 1, total: 2 })

    const failedRepository = {
      ...repository,
      admitAgentRun: vi.fn(async () => undefined),
      beginAgentAttempt: vi.fn(async () => 1),
      settleAgentRun: vi.fn(async () => undefined),
    }
    const failure = new Error('controlled failure')
    await expect(retainPreparedExtensionSkillResult({
      ...prepared,
      admission: { ...prepared.admission, execute: vi.fn(async () => { throw failure }) },
    }, {
      repository: failedRepository,
      runId: 'run-failed', outlineId: 'outline-one', invocationNodeId: 'invocation',
      now: () => '2026-09-20T10:00:00.000Z',
    })).rejects.toBe(failure)
    expect(failedRepository.settleAgentRun).toHaveBeenCalledWith(
      'run-failed', 'failed', null, null, 'execution_failed', '2026-09-20T10:00:00.000Z',
    )

    const cancelledRepository = {
      ...failedRepository,
      settleAgentRun: vi.fn(async () => undefined),
    }
    const cancellation = new DOMException('cancelled', 'AbortError')
    await expect(retainPreparedExtensionSkillResult({
      ...prepared,
      admission: { ...prepared.admission, execute: vi.fn(async () => { throw cancellation }) },
    }, {
      repository: cancelledRepository,
      runId: 'run-cancelled', outlineId: 'outline-one', invocationNodeId: 'invocation',
      now: () => '2026-09-20T10:00:00.000Z',
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelledRepository.settleAgentRun).toHaveBeenCalledWith(
      'run-cancelled', 'cancelled', null, null, null, '2026-09-20T10:00:00.000Z',
    )
  })
})
