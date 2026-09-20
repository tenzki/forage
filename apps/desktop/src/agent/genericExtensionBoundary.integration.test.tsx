import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import {
  admitExtensionSkillPreparedPlan,
  extensionCatalogSchema,
  type ExtensionCatalog,
  type ExtensionConfiguration,
  type ExtensionJsonObject,
  type ExtensionSkillDefinition,
} from '@forage/agent-runtime'
import { labelNotesExecutor } from '../../../../extensions/reference/src/index'
import { BulletAttributes } from '../editor/extensions'
import { InternalLink } from '../editor/internalLinks'
import { ExtensionSkillConfigurationForm, configurationWithDefaults } from '../components/Settings/ExtensionSkillConfigurationForm'
import { commitExtensionSkillResult } from './insertIntoEditor'
import { NativeEventRepository, type LocalAgentRun } from '../persistence/eventStore'
import { placeRetainedExtensionSkillResult } from './extensionResultPlacement'
import {
  assertExtensionExecutionLocation,
  executePreparedExtensionSkill,
  prepareExtensionSkillInvocation,
  retainPreparedExtensionSkillResult,
  selectedExtensionExecutor,
} from './extensionSkillInvocation'
import type { ExtensionExecutorBridge, PreparedExtensionExecutorAdmission } from './extensionExecutorClient'

const extensionId = 'dev.forage.text-stats'
const installationId = 'reference-fixture'
const digest = 'b'.repeat(64)
const sourceRevision = 'reference-source-1'

const executorDeclaration = {
  id: labelNotesExecutor.id,
  name: labelNotesExecutor.name,
  description: labelNotesExecutor.description,
  allowEmptyPrompt: labelNotesExecutor.allowEmptyPrompt,
  configuration: structuredClone(labelNotesExecutor.configuration),
}

const catalog: ExtensionCatalog = extensionCatalogSchema.parse({
  version: 1,
  revision: 'a'.repeat(64),
  entries: [{
    source: { kind: 'local', installationId, requestedPath: '/reference', canonicalPath: '/reference' },
    manifest: {
      id: extensionId,
      name: 'Text Stats',
      version: '0.1.0',
      description: 'Deterministic non-evaluation reference extension.',
      entry: './dist/index.js',
      contributes: { tools: [], hooks: [], settings: [], executors: [executorDeclaration] },
    },
    provenance: { installationId, extensionId, sourceKind: 'local', sourceRevision, entryDigest: digest },
    status: 'ready',
    tools: [],
    executors: [{ ...executorDeclaration, available: true, diagnostics: [] }],
    diagnostics: [],
  }],
})

const localConfiguration: ExtensionConfiguration = {
  version: 1,
  revision: 19,
  sources: [{
    installationId,
    source: { kind: 'local', path: '/reference' },
    enabled: true,
    trust: { accepted: true, extensionId },
    settings: {},
    secretReferences: {},
  }],
}

const skill: ExtensionSkillDefinition = {
  id: 'reference-labels',
  label: 'label-notes',
  description: 'Label matching notes.',
  execution: 'extension',
  executor: { extensionId, executorId: labelNotesExecutor.id },
  configuration: {},
}

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes, InternalLink],
    content: { type: 'doc', content: [{ type: 'bulletList', content: [{
      type: 'listItem', attrs: { nodeId: 'parent' }, content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Notes' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', attrs: { nodeId: 'alpha' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha note' }] }] },
          { type: 'listItem', attrs: { nodeId: 'beta' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Beta note' }] }] },
          { type: 'listItem', attrs: { nodeId: 'invocation' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '/label-notes ' }] }] },
        ] },
      ],
    }] }] },
  })
}

function bridge(): ExtensionExecutorBridge {
  return {
    async admit(input, callbacks): Promise<PreparedExtensionExecutorAdmission> {
      const signal = callbacks?.signal ?? new AbortController().signal
      const operation = { signal, settings: {}, log: callbacks?.onLog ?? (() => undefined) }
      const validation = await labelNotesExecutor.validateConfiguration({ configuration: input.configuration }, operation)
      if (!validation.valid) throw new Error(validation.issues?.map(({ message }) => message).join(' ') || 'Invalid configuration.')
      const prepared = await labelNotesExecutor.prepare(
        { runId: input.runId, configuration: input.configuration, context: input.context },
        { ...operation, reportProgress: callbacks?.onProgress ?? (() => undefined) },
      )
      const plan = admitExtensionSkillPreparedPlan(prepared, input.context, input.hostAdmittedReferenceIds)
      return {
        admissionId: `fixture:${input.runId}`,
        executorSnapshot: {
          version: 1,
          catalogRevision: input.catalog.revision,
          configurationRevision: input.localConfiguration.revision,
          source: { installationId, extensionId, sourceRevision, entryDigest: digest, executorId: labelNotesExecutor.id },
        },
        portableConfigurationRevision: input.portableConfigurationRevision,
        configuration: structuredClone(input.configuration),
        context: structuredClone(input.context),
        plan,
        async execute(secrets = {}, executionCallbacks = {}) {
          return labelNotesExecutor.execute(
            { runId: input.runId, configuration: input.configuration, context: input.context, plan },
            {
              signal: executionCallbacks.signal ?? new AbortController().signal,
              settings: {},
              secrets,
              reportProgress: executionCallbacks.onProgress ?? (() => undefined),
              log: executionCallbacks.onLog ?? (() => undefined),
            },
          )
        },
        release: vi.fn(async () => undefined),
      }
    },
  }
}

describe('non-evaluation extension boundary proof', () => {
  let editor: Editor | undefined
  afterEach(() => {
    editor?.destroy()
    clearMocks()
  })

  it('uses the generic form, preparation, execution, references, and ordinary undoable output without app changes', async () => {
    const user = userEvent.setup()
    let configured: ExtensionJsonObject = configurationWithDefaults(labelNotesExecutor.configuration)
    function FormHarness() {
      const [value, setValue] = useState(configured)
      return <ExtensionSkillConfigurationForm
        form={labelNotesExecutor.configuration}
        configuration={value}
        onChange={(next) => { configured = next; setValue(next) }}
      />
    }
    render(<FormHarness />)
    await user.type(screen.getByLabelText('Text to match'), 'alpha')
    await user.clear(screen.getByLabelText('Output prefix'))
    await user.type(screen.getByLabelText('Output prefix'), 'Found')
    await user.click(screen.getByLabelText('Include stable IDs'))
    await user.selectOptions(screen.getByLabelText('ID separator'), 'colon')

    editor = createEditor()
    const configuredSkill = { ...skill, configuration: configured }
    const prepared = await prepareExtensionSkillInvocation({
      skill: configuredSkill,
      prompt: '',
      doc: editor.state.doc,
      invocationNodeId: 'invocation',
      catalog,
      localConfiguration,
      portableConfigurationRevision: 73,
      runId: 'generic-proof',
      bridge: bridge(),
    })
    expect(prepared.admission.executorSnapshot.configurationRevision).toBe(19)
    expect(prepared.admission.portableConfigurationRevision).toBe(73)
    expect(prepared.admission.plan.selectedNodeIds).toEqual(['alpha'])

    const progress = vi.fn()
    const result = await executePreparedExtensionSkill(prepared, { onProgress: progress })
    expect(result.nodes[0]).toMatchObject({
      type: 'text',
      segments: [
        { type: 'text', text: 'Found: alpha: ' },
        { type: 'internal-reference', nodeId: 'alpha', label: 'Alpha note' },
      ],
    })
    expect(progress).toHaveBeenLastCalledWith({ message: 'Formatting matching notes', completed: 1, total: 1 })

    commitExtensionSkillResult(editor, 'invocation', configuredSkill.label, 'generic-proof', result, prepared.admission.plan.admittedReferenceIds)
    expect(editor.view.dom.querySelector<HTMLAnchorElement>('a[data-internal-node-id="alpha"]')?.textContent).toBe('Alpha note')
    expect(editor.state.doc.textContent).toContain('Found: alpha: Alpha note')
    expect(JSON.stringify(editor.getJSON())).not.toMatch(/system.?one|jev|typesafe/i)

    editor.commands.undo()
    expect(editor.state.doc.textContent).toContain('/label-notes ')
    editor.commands.redo()
    expect(editor.state.doc.textContent).toContain('Found: alpha: Alpha note')

    expect(() => selectedExtensionExecutor(configuredSkill, null)).toThrow(/not installed/i)
    expect(editor.state.doc.textContent).toContain('Found: alpha: Alpha note')
    expect(() => assertExtensionExecutionLocation('server')).toThrow(/no desktop fallback/i)
  })

  it('propagates cancellation through the same generic executor contract', async () => {
    editor = createEditor()
    const prepared = await prepareExtensionSkillInvocation({
      skill: { ...skill, configuration: { contains: 'alpha', prefix: 'Found' } },
      prompt: '',
      doc: editor.state.doc,
      invocationNodeId: 'invocation',
      catalog,
      localConfiguration,
      portableConfigurationRevision: 1,
      runId: 'generic-cancel',
      bridge: bridge(),
    })
    const controller = new AbortController()
    controller.abort(new Error('cancelled generic smoke'))
    await expect(executePreparedExtensionSkill(prepared, { signal: controller.signal }))
      .rejects.toThrow(/cancelled generic smoke/i)
    expect(editor.state.doc.textContent).not.toContain('Found:')
  })

  it('retains and places the ordinary result after a Tauri-mocked restart without loading extension code again', async () => {
    const runs = new Map<string, LocalAgentRun>()
    mockIPC((command, payload = {}) => {
      const args = !Array.isArray(payload) && typeof payload === 'object' && payload !== null
        ? payload as Record<string, unknown>
        : {}
      if (command === 'agent_run_admit') {
        const run = structuredClone(args.run) as LocalAgentRun
        runs.set(run.id, run)
        return undefined
      }
      const runId = String(args.runId ?? '')
      const run = runs.get(runId)
      if (command === 'agent_run_begin_attempt' && run) {
        run.status = 'running'
        run.attemptCount += 1
        return run.attemptCount
      }
      if (command === 'agent_run_settle' && run) {
        run.status = args.status as LocalAgentRun['status']
        run.resultIdentity = args.resultIdentity as string | null
        run.result = structuredClone(args.result) as LocalAgentRun['result']
        run.errorCode = args.errorCode as string | null
        run.updatedAt = String(args.settledAt)
        return undefined
      }
      if (command === 'agent_run_get') return run ? structuredClone(run) : null
      if (command === 'agent_run_place_result' && run) {
        run.status = 'completed'
        run.updatedAt = String(args.placedAt)
        return undefined
      }
      throw new Error(`Unexpected mocked Tauri command: ${command}`)
    })

    editor = createEditor()
    const configuredSkill = { ...skill, configuration: { contains: 'alpha', prefix: 'Restarted' } }
    const prepared = await prepareExtensionSkillInvocation({
      skill: configuredSkill,
      prompt: '',
      doc: editor.state.doc,
      invocationNodeId: 'invocation',
      catalog,
      localConfiguration,
      portableConfigurationRevision: 5,
      runId: 'tauri-mocked-run',
      bridge: bridge(),
    })
    const firstRepository = new NativeEventRepository()
    await retainPreparedExtensionSkillResult(prepared, {
      repository: firstRepository,
      runId: 'tauri-mocked-run',
      outlineId: 'outline-one',
      invocationNodeId: 'invocation',
      now: () => '2026-09-20T12:00:00.000Z',
    })

    // A fresh repository instance models reopening the Tauri frontend. Placement
    // consumes only the retained generic snapshot/result, not the extension.
    const restartedRepository = new NativeEventRepository()
    const retained = await restartedRepository.agentRun('tauri-mocked-run')
    expect(retained?.status).toBe('completed_unplaced')
    await placeRetainedExtensionSkillResult(
      editor,
      retained!,
      'invocation',
      restartedRepository,
      () => '2026-09-20T12:01:00.000Z',
    )
    expect(editor.state.doc.textContent).toContain('Restarted: Alpha note')
    expect(editor.view.dom.querySelector('a[data-internal-node-id="alpha"]')).not.toBeNull()
    expect(runs.get('tauri-mocked-run')?.status).toBe('completed')
  })
})
