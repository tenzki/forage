import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => undefined),
  handlers: new Set<(event: { payload: unknown }) => void>(),
  pageState: null as ((event: { payload: unknown }) => void) | null,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    native.pageState = handler
    native.handlers.add(handler)
    return () => { native.handlers.delete(handler) }
  }),
}))
vi.mock('../../editor/readerDocument', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../editor/readerDocument')>()),
  fetchReaderDocument: vi.fn(async (href: string) => ({
    href,
    host: new URL(href).hostname,
    title: 'Reader title',
    blocks: [],
    minutes: 1,
    fetchedAt: 0,
  })),
}))

import * as externalLinks from '../../editor/externalLinks'
import { fetchReaderDocument } from '../../editor/readerDocument'
import { DocumentCoordinator } from '../../editor/DocumentCoordinator'
import { findBullet, trashBullet } from '../../editor/outlineModel'
import { OUTLINE_RUN_SKILL_EVENT } from '../../agent/skillRuns'
import { LinkPeekPane } from './LinkPeekPane'

function calls(command: string) {
  return native.invoke.mock.calls.filter(([name]) => name === command)
}

describe('LinkPeekPane page mode', () => {
  beforeEach(() => {
    // jsdom does not implement element scrolling.
    Element.prototype.scrollTo ??= () => undefined
    native.invoke.mockReset()
    native.invoke.mockImplementation(async (command, args) => (command === 'page_peek_create' ? `resource-${(args as { paneId: string }).paneId}` : command === 'page_peek_snapshot' ? new ArrayBuffer(4) : undefined) as never)
    vi.mocked(fetchReaderDocument).mockClear()
    native.pageState = null
    native.handlers.clear()
  })

  it('moves mode and secondary controls into accessible overflow in a narrow workspace pane', async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 180, height: 600 } as DOMRect)
    const { unmount, container } = render(<LinkPeekPane editor={null} href="https://example.com/start" paneActions={<button>Pane actions</button>} onClose={() => undefined} />)
    expect(container.querySelector('.link-peek-pane')?.classList.contains('is-compact')).toBe(true)
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)
    expect(screen.getByRole('button', { name: 'Copy link' }).closest('details')).toBe(details)
    act(() => { details.open = true })
    expect(screen.getByRole('button', { name: 'Reader' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
    unmount(); bounds.mockRestore()
  })

  it('opens on the live page and follows its navigation', async () => {
    const { unmount } = render(
      <LinkPeekPane editor={null} href="https://example.com/start" onClose={() => undefined} />,
    )
    // Loading starts straight away; the page is shown once the pane settles.
    await waitFor(() => expect(calls('page_peek_load')).toHaveLength(1))
    const resourceId = (calls('page_peek_load')[0]![1] as { resourceId: string }).resourceId
    expect(calls('page_peek_load')[0]![1]).toEqual({ resourceId, generation: 1, url: 'https://example.com/start' })
    await waitFor(() => expect(calls('page_peek_present').filter(([, args]) => (args as { visible: boolean }).visible)).toHaveLength(1))
    expect(screen.getByText(/Live page/u)).toBeTruthy()
    await waitFor(() => expect(calls('workspace_focus').some(([, args]) => (args as { page: boolean }).page)).toBe(true))
    // The reader is not fetched until it is asked for.
    expect(fetchReaderDocument).not.toHaveBeenCalled()

    // The pane slides in without resizing; the page must follow it anyway.
    const surface = document.querySelector('.link-peek-page')!
    surface.getBoundingClientRect = () => ({ left: 500, top: 60, width: 400, height: 700 }) as DOMRect
    fireEvent.scroll(document)
    await waitFor(() => expect(calls('page_peek_present').some(([, args]) =>
      (args as { bounds: { x: number } }).bounds.x === 500)).toBe(true))

    await waitFor(() => expect(native.pageState).not.toBeNull())
    act(() => native.pageState!({ payload: { resourceId, generation: 1, url: 'https://other.org/next', loading: false, title: null } }))
    expect(screen.getByText('other.org')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(calls('page_peek_navigate')[0]![1]).toEqual({ resourceId, action: 'back' }))

    // To the reader: the live view hides and the reader shows the same page.
    fireEvent.click(screen.getByRole('button', { name: 'Reader' }))
    await waitFor(() => {
      const visibility = calls('page_peek_present')
      expect((visibility[visibility.length - 1]?.[1] as { visible: boolean }).visible).toBe(false)
    })
    await waitFor(() => expect(document.querySelector('.link-peek-meta')?.textContent).toBe('other.org  ·  1 min read'))
    expect(fetchReaderDocument).toHaveBeenCalledTimes(1)

    // Back and forth again does not fetch the reader a second time.
    fireEvent.click(screen.getByRole('button', { name: 'Page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reader' }))
    await screen.findByRole('heading', { name: 'Reader title' })
    expect(fetchReaderDocument).toHaveBeenCalledTimes(1)

    unmount()
    await waitFor(() => expect(calls('page_peek_close')).toHaveLength(1))
  })

  it('leaves a picture of the page in its place while a dialog is up', async () => {
    URL.createObjectURL ??= () => ''
    URL.revokeObjectURL ??= () => undefined
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:still')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    const { container, unmount } = render(
      <LinkPeekPane editor={null} href="https://example.com/start" onClose={() => undefined} />,
    )
    await waitFor(() => expect(calls('page_peek_present').filter(([, args]) => (args as { visible: boolean }).visible)).toHaveLength(1))

    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
    // The picture is taken before the page goes, and shown where it was.
    await waitFor(() => expect(container.querySelector('.link-peek-page-still')?.getAttribute('src')).toBe('blob:still'))
    expect(calls('page_peek_snapshot')).toHaveLength(1)
    const visibility = () => calls('page_peek_present').map(([, args]) => (args as { visible: boolean }).visible)
    await waitFor(() => expect(visibility().slice(-1)[0]).toBe(false))

    dialog.remove()
    await waitFor(() => expect(visibility().slice(-1)[0]).toBe(true))
    await waitFor(() => expect(container.querySelector('.link-peek-page-still')).toBeNull())
    expect(revoked).toHaveBeenCalledWith('blob:still')

    unmount()
    created.mockRestore()
    revoked.mockRestore()
    native.invoke.mockImplementation(async () => undefined)
  })
})

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function article(href: string, title: string) { return { href, host: new URL(href).hostname, title, blocks: [], minutes: 1, fetchedAt: 0 } }

describe('independent workspace web panes', () => {
  beforeEach(() => {
    native.invoke.mockReset(); native.handlers.clear()
    native.invoke.mockImplementation(async (command, args) => (command === 'page_peek_create' ? `resource-${(args as { paneId: string }).paneId}` : command === 'page_peek_snapshot' ? new ArrayBuffer(4) : undefined) as never)
    vi.mocked(fetchReaderDocument).mockReset().mockImplementation(async href => article(href, 'Reader title'))
  })
  it('retains resources, mode and Reader content across focus and application views', async () => {
    const panes = (active: string, visible = true) => <><LinkPeekPane paneId="a" active={active === 'a'} visible={visible} editor={null} href="https://a.test" onClose={() => undefined}/><LinkPeekPane paneId="b" active={active === 'b'} visible={visible} editor={null} href="https://b.test" onClose={() => undefined}/></>
    const { container, rerender, unmount } = render(panes('a'))
    await waitFor(() => expect(calls('page_peek_create')).toHaveLength(2))
    const a = within(container.querySelector('[data-page-owner="a"]') as HTMLElement)
    fireEvent.click(a.getByRole('button', { name: 'Reader' })); await a.findByRole('heading', { name: 'Reader title' })
    rerender(panes('b')); rerender(panes('b',false))
    await waitFor(() => expect(calls('page_peek_present').filter(([,args]) => !(args as {visible:boolean}).visible).length).toBeGreaterThan(0))
    rerender(panes('a'))
    expect(a.getByRole('button',{name:'Reader'}).getAttribute('aria-pressed')).toBe('true')
    expect(fetchReaderDocument).toHaveBeenCalledTimes(1); expect(calls('page_peek_create')).toHaveLength(2); expect(calls('page_peek_close')).toHaveLength(0)
    unmount(); await waitFor(() => expect(calls('page_peek_close')).toHaveLength(2)); expect(native.handlers.size).toBe(0)
  })
  it('does not steal focus when native creation finishes after another pane was activated', async () => {
    const created = deferred<string>()
    native.invoke.mockImplementation(async command => (command === 'page_peek_create' ? created.promise : undefined) as never)
    const props = {paneId:'slow',editor:null,href:'https://slow.test',onClose:() => undefined}
    const { rerender, unmount } = render(<LinkPeekPane {...props} active />)
    await waitFor(() => expect(calls('page_peek_create')).toHaveLength(1))
    rerender(<LinkPeekPane {...props} active={false}/>)
    await act(async () => { created.resolve('slow-resource') })
    await waitFor(() => expect(calls('page_peek_present').length).toBeGreaterThan(0))
    expect(calls('workspace_focus').filter(([,args]) => (args as {page:boolean}).page)).toHaveLength(0)
    unmount()
  })
  it('ignores stale Reader completions on navigation and close', async () => {
    const first=deferred<ReturnType<typeof article>>(), second=deferred<ReturnType<typeof article>>()
    const signals: AbortSignal[]=[]
    vi.mocked(fetchReaderDocument).mockImplementation((href,signal) => { signals.push(signal!); return href === 'https://a.test' ? first.promise : second.promise })
    const { rerender,unmount }=render(<LinkPeekPane paneId="a" editor={null} href="https://a.test" onClose={() => undefined}/>)
    fireEvent.click(screen.getByRole('button',{name:'Reader'}))
    rerender(<LinkPeekPane paneId="a" editor={null} href="https://new.test" onClose={() => undefined}/>)
    expect(signals[0].aborted).toBe(true)
    await act(async () => { first.resolve(article('https://a.test','Stale article')) })
    expect(screen.queryByText('Stale article')).toBeNull()
    unmount(); expect(signals[1].aborted).toBe(true)
    await act(async () => { second.resolve(article('https://new.test','Late article')) })
    expect(screen.queryByText('Late article')).toBeNull()
  })
  it('keeps failure and native events in their addressed pane and offers retry', async () => {
    native.invoke.mockImplementation(async (command,args) => {
      const data=args as {paneId?:string;resourceId?:string}
      if(command==='page_peek_create')return `resource-${data.paneId}` as never
      if(command==='page_peek_load' && data.resourceId==='resource-a')throw new Error('Viewer unavailable')
      return undefined
    })
    const { container,unmount }=render(<><LinkPeekPane paneId="a" editor={null} href="https://a.test" onClose={() => undefined}/><LinkPeekPane paneId="b" active={false} editor={null} href="https://b.test" onClose={() => undefined}/></>)
    const a=within(container.querySelector('[data-page-owner="a"]') as HTMLElement), b=within(container.querySelector('[data-page-owner="b"]') as HTMLElement)
    await a.findByText('Viewer unavailable'); expect(b.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(calls('page_peek_load')).toHaveLength(2))
    act(() => native.handlers.forEach(h => h({payload:{resourceId:'resource-b',paneId:'b',generation:1,url:'https://other.test/next',loading:false}})))
    expect(b.getByText('other.test')).toBeTruthy(); expect(a.queryByText('other.test')).toBeNull()
    fireEvent.click(a.getByRole('button',{name:'Retry'})); await waitFor(() => expect(calls('page_peek_create')).toHaveLength(3))
    expect(calls('page_peek_create').filter(([,args])=>(args as {paneId:string}).paneId==='b')).toHaveLength(1)
    unmount()
  })
  it('offers Reader-link open-right while ordinary and mail links keep their existing routes', async () => {
    const openRight=vi.fn(), onNavigate=vi.fn(), external=vi.spyOn(externalLinks,'openExternally').mockImplementation(() => undefined)
    vi.mocked(fetchReaderDocument).mockResolvedValue({ ...article('https://a.test','Links'), blocks:[{type:'paragraph',content:[{type:'link',href:'https://next.test',children:[{type:'text',text:'Next'}]},{type:'link',href:'mailto:reader@example.com',children:[{type:'text',text:'Email'}]}]}] })
    render(<LinkPeekPane paneId="a" editor={null} href="https://a.test" onOpenRight={openRight} navigation={{canBack:false,canForward:false,onNavigate,onBack:vi.fn(),onForward:vi.fn()}} onClose={() => undefined}/>)
    fireEvent.click(screen.getByRole('button',{name:'Reader'})); const link=await screen.findByRole('link',{name:'Next'})
    fireEvent.click(link); expect(onNavigate).toHaveBeenCalledWith('https://next.test'); expect(openRight).not.toHaveBeenCalled()
    fireEvent.contextMenu(link,{clientX:100,clientY:80}); fireEvent.click(screen.getByRole('menuitem',{name:'Open in right pane'}))
    expect(openRight).toHaveBeenCalledWith('https://next.test/')
    fireEvent.click(link,{metaKey:true}); expect(external).toHaveBeenCalledWith('https://next.test')
    fireEvent.click(screen.getByRole('link',{name:'Email'})); expect(external).toHaveBeenCalledWith('mailto:reader@example.com')
    expect(onNavigate).toHaveBeenCalledTimes(1); external.mockRestore()
  })
  it('publishes live navigation once for Split and ignores native responses while browsing Reader', async () => {
    const onNavigate = vi.fn()
    const nav = {canBack:false,canForward:false,onNavigate,onBack:vi.fn(),onForward:vi.fn()}
    const props = {paneId:'a',editor:null,navigation:nav,onClose:() => undefined}
    const { rerender } = render(<LinkPeekPane {...props} href="https://a.test"/>)
    await waitFor(() => expect(calls('page_peek_load')).toHaveLength(1))
    const send = (url: string) => act(() => native.handlers.forEach(h => h({payload:{resourceId:'resource-a',paneId:'a',generation:1,url,loading:false}})))
    send('https://next.test/'); expect(onNavigate).toHaveBeenCalledWith('https://next.test/')
    rerender(<LinkPeekPane {...props} href="https://next.test/"/>)
    send('https://next.test/'); expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(calls('page_peek_load')).toHaveLength(1) // Echoing native URL must preserve its history.
    fireEvent.click(screen.getByRole('button',{name:'Reader'})); await screen.findByRole('heading',{name:'Reader title'})
    rerender(<LinkPeekPane {...props} href="https://reader.test"/>)
    send('https://late.test/'); expect(onNavigate).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.querySelector('.link-peek-meta')?.textContent).toContain('reader.test'))
    fireEvent.click(screen.getByRole('button',{name:'Page'}))
    await waitFor(() => expect(calls('page_peek_load')).toHaveLength(2))
    expect((calls('page_peek_load')[1][1] as {url:string}).url).toBe('https://reader.test')
  })
  it('clips and summarizes through the canonical document under the original source after another view gains focus, then explains deletion', async () => {
    const item=(id:string,text:string)=>({type:'listItem',attrs:{nodeId:id},content:[{type:'paragraph',content:[{type:'text',text}]}]})
    const coordinator=new DocumentCoordinator({type:'doc',content:[{type:'bulletList',content:[item('source','Source'),item('other','Other')]}]})
    const first=coordinator.createView('first'), second=coordinator.createView('second')
    const run=vi.fn(); window.addEventListener(OUTLINE_RUN_SKILL_EVENT,run)
    const { unmount }=render(<LinkPeekPane paneId="web" editor={first} sourceNodeId="source" href="https://a.test" onClose={() => undefined}/>)
    act(() => { const bullet=findBullet(second.state.doc,'other')!; second.commands.setTextSelection(bullet.pos+2); coordinator.activate('second') })
    fireEvent.click(screen.getByRole('button',{name:'Clip to outline'}))
    expect(findBullet(coordinator.editor.state.doc,'source')!.node.textContent).toContain('a.test')
    expect(findBullet(coordinator.editor.state.doc,'other')!.node.textContent).toBe('Other')
    const summary=screen.getByRole('button',{name:'Summarize into outline'}) as HTMLButtonElement
    expect(summary.disabled).toBe(false); fireEvent.click(summary)
    expect(run).toHaveBeenCalledTimes(1)
    expect(findBullet(coordinator.editor.state.doc,'source')!.node.textContent).toContain('Summarize https://a.test')
    expect(first.state.doc.eq(second.state.doc)).toBe(true)
    act(() => { trashBullet(coordinator.editor,'source') })
    expect((screen.getByRole('button',{name:'Clip to outline'}) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Original linking bullet unavailable/u)).toBeTruthy()
    unmount(); window.removeEventListener(OUTLINE_RUN_SKILL_EVENT,run); coordinator.destroy()
  })
})
