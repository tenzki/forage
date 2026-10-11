import { beforeEach, describe, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Set<(e: { payload: unknown }) => void>(), stop: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_: string, handler: (e: { payload: unknown }) => void) => {
  native.handlers.add(handler); return () => { native.handlers.delete(handler); native.stop() }
}) }))
import { PageLease, boundsOf, observePageGeometry, hasPageOverlay, pageResourceOwnedBy } from './pagePeek'
const bounds = { x: 0, y: 48, width: 600, height: 400, clipX: 0, clipY: 48, clipWidth: 300, clipHeight: 400, viewportWidth: 1000, viewportHeight: 600 }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const settle = () => new Promise(r => setTimeout(r, 0))
beforeEach(() => { native.invoke.mockReset(); native.handlers.clear(); native.stop.mockClear(); native.invoke.mockImplementation(async (command, args) => command === 'page_peek_create' ? `resource-${args.paneId}` : undefined) })
describe('Page leases', () => {
  it('addresses every operation and event to one live resource and generation', async () => {
    const aState = vi.fn(), bState = vi.fn(), a = new PageLease('a', aState), b = new PageLease('b', bState)
    await Promise.all([a.load('https://a.test'), b.load('https://b.test')])
    await a.navigate('back'); await b.present(bounds, true); await b.focus()
    expect(native.invoke).toHaveBeenCalledWith('page_peek_navigate', { resourceId: 'resource-a', action: 'back' })
    expect(native.invoke).toHaveBeenCalledWith('workspace_focus', { resourceId: 'resource-b', page: true })
    const send = (s: object) => native.handlers.forEach(h => h({ payload: s }))
    send({ resourceId: 'resource-a', paneId: 'a', generation: 1, url: 'https://a.test', loading: false })
    expect(aState).toHaveBeenCalledTimes(1); expect(bState).not.toHaveBeenCalled()
    await a.load('https://new.test')
    send({ resourceId: 'resource-a', paneId: 'a', generation: 1, url: 'https://old.test', loading: false })
    expect(aState).toHaveBeenCalledTimes(1)
    a.dispose(); expect(pageResourceOwnedBy('resource-a', 'a')).toBe(false)
    await settle(); expect(pageResourceOwnedBy('resource-a', 'a')).toBe(false)
    expect(native.handlers.size).toBe(1)
    send({ resourceId: 'resource-a', paneId: 'a', generation: 2, url: 'https://late.test', loading: false })
    expect(aState).toHaveBeenCalledTimes(1)
    await expect(a.navigate('reload')).rejects.toThrow('closed')
    expect(pageResourceOwnedBy('resource-b', 'b')).toBe(true)
    b.dispose(); await settle(); expect(native.handlers.size).toBe(0)
  })
  it('closes a late-created resource and cancels queued work', async () => {
    const created = deferred<string>()
    native.invoke.mockImplementation((command) => command === 'page_peek_create' ? created.promise : Promise.resolve())
    const lease = new PageLease('a', vi.fn()); const loading = lease.load('https://a.test').catch(e => e)
    await settle(); lease.dispose(); created.resolve('late-id'); await loading; await settle()
    expect(native.invoke).toHaveBeenCalledWith('page_peek_close', { resourceId: 'late-id' })
    expect(native.invoke.mock.calls.some(([command]) => command === 'page_peek_load')).toBe(false)
    expect(native.handlers.size).toBe(0)
  })
  it('discards a snapshot completed after navigation or close before allocating a URL', async () => {
    URL.createObjectURL ??= () => ''; const url = vi.spyOn(URL, 'createObjectURL')
    const image = deferred<ArrayBuffer>()
    native.invoke.mockImplementation(async (command, args) => command === 'page_peek_create' ? `resource-${args.paneId}` : command === 'page_peek_snapshot' ? image.promise : undefined)
    const lease = new PageLease('a', vi.fn()); await lease.load('https://a.test')
    const snapshot = lease.snapshot(); await settle(); await lease.load('https://next.test'); image.resolve(new ArrayBuffer(4))
    expect(await snapshot).toBeNull(); expect(url).not.toHaveBeenCalled(); lease.dispose(); await settle(); url.mockRestore()
  })
  it('releases a registered listener after native creation fails', async () => {
    native.invoke.mockRejectedValue(new Error('viewer unavailable'))
    const lease = new PageLease('a', vi.fn())
    await expect(lease.load('https://a.test')).rejects.toThrow('unavailable')
    expect(native.handlers.size).toBe(0); lease.dispose()
    expect(native.handlers.size).toBe(0)
  })
})
describe('coalesced geometry', () => {
  it('ignores hidden overlays and includes the actual link hover card', () => {
    const bubble=document.createElement('div'); bubble.className='formatting-bubble'; bubble.style.visibility='hidden'; document.body.append(bubble)
    expect(hasPageOverlay()).toBe(false)
    bubble.style.visibility='visible'; expect(hasPageOverlay()).toBe(true); bubble.remove()
    const card=document.createElement('div'); card.className='link-card'; document.body.append(card); expect(hasPageOverlay()).toBe(true); card.remove()
  })
  it('intersects the strip without shrinking the full page bounds', () => {
    const strip = document.createElement('div'); strip.className = 'workspace-panes'; const page = document.createElement('div'); strip.append(page); document.body.append(strip)
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 }); Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 700 })
    strip.getBoundingClientRect = () => ({ left: 56, right: 800, top: 0, bottom: 700 }) as DOMRect
    page.getBoundingClientRect = () => ({ left: -100, right: 500, top: 48, bottom: 648, width: 600, height: 600 }) as DOMRect
    expect(boundsOf(page)).toEqual({ x: -100, y: 48, width: 600, height: 600, clipX: 56, clipY: 48, clipWidth: 444, clipHeight: 600, viewportWidth: 1000, viewportHeight: 700 })
    strip.remove()
  })
  it('coalesces a scroll burst for all pages and has no idle frame loop', async () => {
    const a = document.createElement('div'), b = document.createElement('div'); document.body.append(a,b)
    const aUpdate=vi.fn(), bUpdate=vi.fn(); const stopA=observePageGeometry(a,aUpdate), stopB=observePageGeometry(b,bUpdate)
    await new Promise(r => setTimeout(r, 30)); aUpdate.mockClear(); bUpdate.mockClear()
    for(let i=0;i<20;i++) document.dispatchEvent(new Event('scroll'))
    await new Promise(r => setTimeout(r,30)); expect(aUpdate).toHaveBeenCalledTimes(1); expect(bUpdate).toHaveBeenCalledTimes(1)
    await new Promise(r => setTimeout(r,30)); expect(aUpdate).toHaveBeenCalledTimes(1)
    stopA(); stopB(); a.remove(); b.remove()
  })
})
