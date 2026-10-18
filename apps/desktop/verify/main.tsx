// Separate verification build; fixture hooks never enter the shipped frontend.
import { createRoot } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { EditorView } from '@tiptap/pm/view'
import App from '../src/App'
import '../src/style.css'
import { disableNativeTextAssistance } from '../src/nativeTextAssistance'
import { documentEditor } from '../src/editor/documentAccess'
import { collectBullets, findBullet, appendChildBullet } from '../src/editor/outlineModel'
import { normalizeOutlinerDoc } from '../src/editor/emptyDoc'
import { requestLinkPeek } from '../src/editor/externalLinks'
import { useSettingsStore } from '../src/store/settingsStore'
import { useExtensionStore } from '../src/store/extensionStore'
import { useMcpStore } from '../src/store/mcpStore'
import { skillExecution } from '../src/agent/skillExecution'
import { LocalAgentExecutor } from '../src/agent/localExecutor'
import { NativeEventRepository } from '../src/persistence/eventStore'
import type { LocalRunResult } from '@forage/agent-runtime'
import { initialProgress, useOnboardingStore } from '../src/onboarding/progress'
const viewUpdates: number[] = []
const updateState = EditorView.prototype.updateState
EditorView.prototype.updateState = function (state) {
  const start = performance.now()
  updateState.call(this, state)
  viewUpdates.push(performance.now() - start)
}
useExtensionStore.setState({
  refresh: async () => undefined,
  catalog: { version: 1, revision: 'a'.repeat(64), entries: [] },
  configuration: { version: 1, revision: 1, sources: [] },
})
useMcpStore.setState({ loaded: true, connections: [] })
disableNativeTextAssistance()
// This fixture verifies the ordinary workspace of an existing installation.
void useOnboardingStore.getState().save(initialProgress(false)).then(() => {
  createRoot(document.getElementById('app')!).render(<App />)
})
const sleep = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const require = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message)
}
async function until(predicate: () => unknown, message: string, timeout = 15000) {
  const started = performance.now()
  while (!predicate()) {
    if (performance.now() - started > timeout) throw new Error(message)
    await sleep(20)
  }
}
function editors(): Editor[] {
  return [
    ...document.querySelectorAll<
      HTMLElement & {
        editor: Editor
      }
    >('.workspace-outline-pane .tiptap'),
  ]
    .map((e) => e.editor)
    .filter(Boolean)
}
function paneId(index: number) {
  return document.querySelectorAll<HTMLElement>('.workspace-outline-pane')[index].dataset.paneId!
}
function owner() {
  return documentEditor(editors()[0])
}
function key(key: string, code: string, shift = false) {
  ;(document.activeElement ?? window).dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code,
      metaKey: true,
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    }),
  )
}
function button(label: string) {
  const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
  )
  require(b, `Missing button ${label}`)
  b!.click()
}
const measurements: unknown[] = []
const objectUrls = new Set<string>()
const createObjectURL = URL.createObjectURL.bind(URL)
const revokeObjectURL = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (blob) => {
  const url = createObjectURL(blob)
  objectUrls.add(url)
  return url
}
URL.revokeObjectURL = (url) => {
  objectUrls.delete(url)
  revokeObjectURL(url)
}
const repository = new NativeEventRepository()
let completeRun: ((result: LocalRunResult) => void) | undefined
let runCompletion: Promise<void> | undefined
let runError: string | null = null
let invocationId = ''
const originalInvoke = LocalAgentExecutor.prototype.invoke
LocalAgentExecutor.prototype.invoke = function (input, options) {
  // Actual admission/activity/result durability, with deterministic model transport.
  const executor = new LocalAgentExecutor(repository, async (_input, runnerOptions) => {
    runnerOptions.onDelta?.('Streaming while source pane closes')
    return new Promise<LocalRunResult>((resolve) => {
      completeRun = resolve
    })
  })
  return originalInvoke.call(executor, input, options)
}
const api = {
  async ready() {
    await until(
      () => editors().length === 1 && useSettingsStore.getState().isLoaded,
      'App did not initialize',
    )
    return { panes: editors().length }
  },
  async seed() {
    const existing = collectBullets(owner().state.doc)
      .filter((b) => b.systemRole !== null)
      .map((b) => b.node.toJSON())
    const content = Array.from({ length: 1000 }, (_, i) => ({
      type: 'listItem',
      attrs: { nodeId: `benchmark-${i}` },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `Bullet ${i}` }] }],
    }))
    owner().commands.setContent(
      normalizeOutlinerDoc({
        type: 'doc',
        content: [{ type: 'bulletList', content: [...existing, ...content] }],
      }) as object,
    )
    await until(() => collectBullets(owner().state.doc).length >= 1000, 'Seed was not projected')
    await sleep(100)
    return { bullets: collectBullets(owner().state.doc).length }
  },
  panes() {
    return {
      outline: editors().length,
      web: document.querySelectorAll('.workspace-web-pane').length,
      ids: editors().map((_, i) => paneId(i)),
      equal: editors().every((e) => e.state.doc.eq(owner().state.doc)),
      text: findBullet(owner().state.doc, 'benchmark-0')?.text,
    }
  },
  async openRightRegression(base: string) {
    const source = editors()[0]
    const section = source.view.dom.closest<HTMLElement>('.workspace-outline-pane')!
    const scroller = section.querySelector<HTMLElement>('.workspace-pane-scroll')!
    scroller.scrollTop = 0
    source.view.dom
      .querySelector<HTMLButtonElement>('[data-node-id="benchmark-0"] .bullet-menu')!
      .click()
    await until(() => Boolean(document.querySelector('[role="menu"]')), 'Bullet menu did not open')
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.startsWith('Open in right pane'))!
      .click()
    await until(() => editors().length === 2, 'Open right did not mount')
    await sleep(100)
    const strip = section.parentElement!
    strip.scrollLeft = 0
    await sleep(100)
    const painted = () => {
      const paragraph = source.view.dom.querySelector<HTMLElement>(
        '[data-node-id="benchmark-0"] > p',
      )!
      const rect = paragraph.getBoundingClientRect()
      const hit = document.elementFromPoint(
        rect.left + Math.min(40, rect.width / 2),
        rect.top + rect.height / 2,
      )
      return {
        sourceConnected: source.view.dom.isConnected,
        sourceText: paragraph.textContent,
        sourcePainted: Boolean(hit && paragraph.contains(hit)),
        sourceHeight: scroller.clientHeight,
        sourceWidth: section.getBoundingClientRect().width,
        paragraphTop: rect.top,
        scrollTop: scroller.scrollTop,
        hit: hit?.outerHTML.slice(0, 200),
        layout: api.layout(),
      }
    }
    const outline = painted()
    require(outline.sourcePainted, `Opening outline blanked source: ${JSON.stringify(outline)}`)
    require(outline.layout.paneWidths.every(
      (width) => width === 480,
    ), 'Inserted panes shrank to fit')
    api.focus(1)
    key('w', 'KeyW')
    await until(() => editors().length === 1, 'Regression pane did not close')
    require(!document.querySelector(
      '[aria-label="Close pane"]',
    ), 'Final pane still has a close button')
    requestLinkPeek(`${base}/source-regression`, 'benchmark-0', paneId(0))
    await until(
      () => Boolean(document.querySelector('.workspace-web-pane')),
      'Web regression pane did not open',
    )
    strip.style.width = '700px'
    strip.scrollLeft = 0
    scroller.scrollTop = 0
    await sleep(150)
    const web = painted()
    require(web.sourcePainted, `Opening Page blanked source: ${JSON.stringify(web)}`)
    require(strip.scrollWidth > strip.clientWidth, 'Multi-pane strip did not overflow horizontally')
    const margins = () => {
      const viewport = strip.getBoundingClientRect()
      return {
        left: section.getBoundingClientRect().left - viewport.left,
        right: viewport.right - strip.lastElementChild!.getBoundingClientRect().right,
        scrollLeft: strip.scrollLeft,
        widths: api.layout().paneWidths,
      }
    }
    strip.style.width = '1200px'
    strip.scrollLeft = 0
    await sleep(100)
    const centered = margins()
    require(centered.left > 0 &&
      Math.abs(centered.left - centered.right) <
        1, `Pane group is not centered: ${JSON.stringify(centered)}`)
    const handle = strip.querySelector<HTMLElement>('[aria-label="Resize last pane"]')!
    require(Boolean(handle), 'Last pane has no outer resize handle')
    const page = strip.querySelector<HTMLElement>('.workspace-web-pane')!
    const drag = async (delta: number) => {
      // Synthetic pointer streams cannot obtain browser-owned capture. Stub only
      // capture for this fixture; real handlers run against actual WebKit layout.
      const original = {
        set: handle.setPointerCapture,
        has: handle.hasPointerCapture,
        release: handle.releasePointerCapture,
      }
      let captured = false
      handle.setPointerCapture = () => {
        captured = true
      }
      handle.hasPointerCapture = () => captured
      handle.releasePointerCapture = () => {
        captured = false
      }
      const start = handle.getBoundingClientRect().right
      const width = page.getBoundingClientRect().width
      const event = (name: string, x: number) =>
        handle.dispatchEvent(
          new PointerEvent(name, {
            bubbles: true,
            pointerId: 1,
            clientX: x,
            clientY: 80,
          }),
        )
      try {
        event('pointerdown', start)
        event('pointermove', start + delta)
        await sleep(100)
        event('pointerup', start + delta)
      } finally {
        handle.setPointerCapture = original.set
        handle.hasPointerCapture = original.has
        handle.releasePointerCapture = original.release
      }
      return {
        before: width,
        after: page.getBoundingClientRect().width,
        edgeMovement: handle.getBoundingClientRect().right - start,
        margins: margins(),
      }
    }
    const centeredDrag = await drag(30)
    require(centeredDrag.after === 540 &&
      Math.abs(centeredDrag.edgeMovement - 30) <
        1, `Centered outer drag did not follow pointer: ${JSON.stringify(centeredDrag)}`)
    require(centeredDrag.margins.widths[0] === 480 &&
      Math.abs(centeredDrag.margins.left - centeredDrag.margins.right) <
        1, 'Outer drag resized source or stopped centering')
    handle.focus()
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft', shiftKey: true }),
    )
    await sleep(100)
    require(page.getBoundingClientRect().width === 490, 'Outer keyboard resize failed')
    strip.style.width = '700px'
    strip.scrollLeft = strip.scrollWidth
    await sleep(100)
    const overflowDrag = await drag(30)
    require(overflowDrag.after ===
      520, `Overflow outer drag failed: ${JSON.stringify(overflowDrag)}`)
    strip.scrollLeft = 0
    await sleep(50)
    const overflow = margins()
    require(overflow.left === 0 &&
      overflow.widths[0] ===
        480, `Overflow leading pane cannot be reached: ${JSON.stringify(overflow)}`)
    strip.style.width = '280px'
    strip.scrollLeft = 0
    await sleep(100)
    const narrow = api.layout()
    require(narrow.paneWidths.every(
      (width) => width >= 360,
    ), 'Narrow viewport compressed multi-pane widths')
    document
      .querySelector<HTMLButtonElement>('.workspace-web-pane [aria-label="Close pane"]')!
      .click()
    await until(
      () => !document.querySelector('.workspace-web-pane'),
      'Web regression pane did not close',
    )
    await sleep(100)
    const singleWidth = section.getBoundingClientRect().width
    require(singleWidth === 280, 'Single pane did not fit narrow viewport')
    strip.style.width = ''
    return { outline, web, centered, centeredDrag, overflowDrag, overflow, narrow, singleWidth }
  },
  progress() {
    return {
      measurements,
      panes: api.panes(),
      active: document.activeElement?.outerHTML.slice(0, 200),
      menus: [
        ...document.querySelectorAll(
          '[aria-modal="true"], [role="menu"], [data-pane-menu="open"], .slash-menu, .internal-link-menu, .tag-menu',
        ),
      ].map((e) => e.outerHTML.slice(0, 200)),
    }
  },
  layout() {
    return {
      headerHeights: [...document.querySelectorAll('.outline-toolbar-bar,.link-peek-toolbar')].map(
        (e) => e.getBoundingClientRect().height,
      ),
      paneWidths: [...document.querySelectorAll('.workspace-panes > [data-pane-id]')].map(
        (e) => e.getBoundingClientRect().width,
      ),
      separatorWidths: [...document.querySelectorAll('.pane-separator')].map(
        (e) => e.getBoundingClientRect().width,
      ),
      objectUrls: objectUrls.size,
    }
  },
  order() {
    return {
      ids: [...document.querySelectorAll<HTMLElement>('.workspace-panes > [data-pane-id]')].map(
        (e) => e.dataset.paneId,
      ),
      active: document.activeElement?.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId,
    }
  },
  focus(index: number) {
    const e = editors()[index]
    // Explicit pane activation reveals an offscreen column before focusing its
    // editor. Direct DOM focus cannot enter content-visibility:hidden content.
    e.view.dom
      .closest('.workspace-outline-pane')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    e.commands.setTextSelection(findBullet(e.state.doc, 'benchmark-0')!.pos + 2)
    e.view.focus()
    require(document.activeElement === e.view.dom, `Pane ${index} did not receive focus`)
    return paneId(index)
  },
  async edit(index: number, text: string) {
    const e = editors()[index]
    e.view.dispatch(e.state.tr.insertText(text, findBullet(e.state.doc, 'benchmark-0')!.pos + 2))
    await sleep()
    return api.panes()
  },
  async undo() {
    key('z', 'KeyZ')
    await sleep(50)
    return api.panes()
  },
  async redo() {
    key('z', 'KeyZ', true)
    await sleep(50)
    return api.panes()
  },
  async web(base: string) {
    requestLinkPeek(`${base}/a`, 'benchmark-0', paneId(0))
    await until(
      () => document.querySelectorAll('.workspace-web-pane').length === 1,
      'First web did not mount',
    )
    requestLinkPeek(`${base}/b`, 'benchmark-0', paneId(0))
    await until(
      () => document.querySelectorAll('.workspace-web-pane').length === 2,
      'Second web did not mount',
    )
    return api.panes()
  },
  async settings(open: boolean) {
    if (open) key(',', 'Comma')
    else button('Back to outline')
    await until(
      () => Boolean(document.querySelector('.settings-panel')) === open,
      'Settings navigation failed',
    )
    return api.panes()
  },
  async startRun() {
    useSettingsStore.setState({
      authMode: 'api_key',
      modelId: 'test-model',
      localCredentials: [{ id: 'verification-openai', provider: 'openai', status: 'connected' }],
      agents: [
        {
          id: 'verification-agent',
          name: 'Verification',
          description: '',
          systemPrompt: 'Help.',
          toolIds: [],
        },
      ],
      skills: [
        {
          id: 'verification-ask',
          label: 'ask',
          description: '',
          execution: 'llm',
          agentId: 'verification-agent',
          systemPrompt: 'Answer.',
          requiredToolIds: [],
        },
      ],
      enabledToolIds: [],
    })
    const source = editors()[1]
    invocationId = appendChildBullet(source, 'benchmark-0', 'Verify closure')!
    source.commands.setTextSelection(findBullet(source.state.doc, invocationId)!.pos + 2)
    source.view.focus()
    const handle = skillExecution.execute(
      {
        editor: source,
        invocationNodeId: invocationId,
        skillId: 'verification-ask',
        prompt: 'Verify closure',
      },
      {
        onError: (error) => {
          runError = error
        },
      },
    )
    runCompletion = handle.completion
    await until(() => completeRun || runError, 'Controlled model transport did not start')
    require(!runError, runError ?? 'Run failed')
    return { invocationId, runId: handle.runId, sourcePaneId: paneId(1) }
  },
  async finishRun() {
    completeRun!({
      version: 1,
      nodes: [{ type: 'text', text: 'Native result after source pane closed' }],
      sources: [],
    })
    await runCompletion
    require(!runError, runError ?? 'Run failed')
    require(findBullet(owner().state.doc, invocationId)?.node.textContent.includes(
      'Native result after source pane closed',
    ), 'Run retargeted or lost')
    return api.panes()
  },
  async persistence() {
    const identity = await repository.identity()
    const events = await repository.eventsAfter(identity.outlineId, 0)
    const runs = await repository.recentAgentRuns(identity.outlineId)
    return {
      count: events.length,
      types: events.map(
        (e) =>
          (
            e.envelope as {
              type: string
            }
          ).type,
      ),
      unique: new Set(events.map((e) => e.id)).size,
      runs: runs.map(({ run }) => ({
        id: run.id,
        status: run.status,
        resultIdentity: run.resultIdentity,
      })),
      text: findBullet(owner().state.doc, 'benchmark-0')?.text,
      runText: findBullet(owner().state.doc, invocationId)?.node.textContent,
    }
  },
  async benchmark() {
    for (const count of [1, 3, 10]) {
      while (editors().length > 1) {
        const before = editors().length
        api.focus(before - 1)
        key('w', 'KeyW')
        await until(
          () => editors().length === before - 1,
          `Benchmark close: ${JSON.stringify(api.progress())}`,
        )
      }
      const opened = performance.now()
      while (editors().length < count) {
        const before = editors().length
        api.focus(before - 1)
        key('\\', 'Backslash', true)
        await until(
          () => editors().length === before + 1,
          `Benchmark open: ${JSON.stringify(api.progress())}`,
        )
      }
      await until(() => editors().length === count, 'Benchmark pane count')
      await sleep(30)
      const mountMs = performance.now() - opened
      const samples: number[] = []
      const updateSamples: number[] = []
      for (let i = 0; i < 12; i++) {
        api.focus(i % count)
        await sleep(30)
        viewUpdates.length = 0
        const start = performance.now()
        await api.edit(i % count, '.')
        await new Promise(requestAnimationFrame)
        samples.push(performance.now() - start)
        updateSamples.push(viewUpdates.reduce((a, b) => a + b, 0))
      }
      samples.sort((a, b) => a - b)
      require(api.panes().equal, 'Benchmark projections diverged')
      updateSamples.sort((a, b) => a - b)
      measurements.push({
        panes: count,
        bullets: collectBullets(owner().state.doc).length,
        mountMs,
        editToFrameMedianMs: samples[6],
        editToFrameP95Ms: samples[11],
        viewUpdateMedianMs: updateSamples[6],
        mountedEditors: editors().length,
        outlineDomItems: document.querySelectorAll('.workspace-outline-pane [data-node-id]').length,
      })
    }
    const cycleStart = performance.now()
    const closed: Editor[] = []
    for (let i = 0; i < 20; i++) {
      const before = editors().length
      api.focus(0)
      key('\\', 'Backslash', true)
      await until(() => editors().length === before + 1, 'Cycle open')
      closed.push(editors()[1])
      api.focus(1)
      key('w', 'KeyW')
      await until(
        () => editors().length === before,
        `Cycle close (${JSON.stringify(measurements)})`,
      )
    }
    require(editors().every((e) => !e.isDestroyed), 'Surviving view destroyed')
    require(closed.every((e) => e.isDestroyed), 'Closed editor leaked')
    return {
      cases: measurements,
      openCloseCycles: 20,
      destroyedEditors: closed.filter((e) => e.isDestroyed).length,
      cycleMs: performance.now() - cycleStart,
      remainingEditors: editors().length,
      objectUrls: objectUrls.size,
      heapBytes:
        (
          performance as Performance & {
            memory?: {
              usedJSHeapSize: number
            }
          }
        ).memory?.usedJSHeapSize ?? null,
    }
  },
  async closeWeb() {
    for (const pane of [...document.querySelectorAll<HTMLElement>('.workspace-web-pane')]) {
      pane.focus()
      key('w', 'KeyW')
      await sleep(20)
    }
    return api.panes()
  },
}
Object.assign(window, { workspaceVerify: api })
