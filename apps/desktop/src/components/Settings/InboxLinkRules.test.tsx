import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AutomationPolicySet } from '@forage/protocol'
import { InboxLinkRules, type InboxLinkRulesTransport } from './InboxLinkRules'

const skills = [
  { id: 'document-repo', label: 'document-repo' },
  { id: 'transcribe', label: 'transcribe' },
  { id: 'research', label: 'research' },
]
const publishedAt = '2026-09-13T10:00:00.000Z'
const noDispatcher = { enabled: false, allowedSkillIds: [] }
const docsRule = { id: 'rule-docs', name: 'Docs', enabled: true, priority: 9, match: { urlHosts: ['github.com'] }, skillIds: ['document-repo'], dispatcher: noDispatcher }
const legacyYoutubeRule = { id: 'youtube-links', name: 'YouTube links', enabled: true, priority: 5, match: { urlTypes: ['youtube' as const] }, skillIds: ['transcribe'], dispatcher: noDispatcher }
const anyRule = { id: 'rule-any', name: 'Everything else', enabled: true, priority: 1, match: { urlTypes: ['youtube' as const, 'x' as const, 'webpage' as const] }, skillIds: ['research'], dispatcher: noDispatcher }

function transportWith(published: AutomationPolicySet | null, overrides: Partial<InboxLinkRulesTransport> = {}) {
  return {
    automation: vi.fn(async () => ({ published: published ? { policies: published, publishedAt } : null })),
    publishAutomation: vi.fn(async (request: unknown) => ({
      policies: (request as { policies: AutomationPolicySet }).policies, publishedAt,
    })),
    ...overrides,
  } satisfies InboxLinkRulesTransport
}

function threeRules() {
  return transportWith({ version: 1, revision: 7, enabled: true, policies: [docsRule, legacyYoutubeRule, anyRule] })
}

function ruleRows() {
  return within(screen.getByTestId('inbox-link-rules')).getAllByRole('listitem')
}

function ruleNames() {
  return ruleRows().map((row) => within(row).getByRole('button', { name: /^Edit / }).getAttribute('aria-label')!.slice('Edit '.length))
}

function publishedRequest(transport: ReturnType<typeof transportWith>) {
  return vi.mocked(transport.publishAutomation).mock.calls[0]![0] as { baseRevision: number; policies: AutomationPolicySet }
}

async function addSkill(user: ReturnType<typeof userEvent.setup>, rule: string, skill: string) {
  await user.click(screen.getByRole('combobox', { name: `Add skill to ${rule}` }))
  await user.click(screen.getByRole('option', { name: `/${skill}` }))
}

afterEach(() => { vi.restoreAllMocks() })

describe('Inbox link rules', () => {
  it('starts with collapsed, disabled GitHub, YouTube, and X rules and requires a skill before publishing', async () => {
    const user = userEvent.setup()
    const transport = transportWith(null)
    render(<InboxLinkRules skills={skills} transport={transport} canPublish />)

    await waitFor(() => expect(ruleRows()).toHaveLength(3))
    expect(ruleNames()).toEqual(['GitHub', 'YouTube', 'X'])
    expect(within(ruleRows()[1]!).getByText('youtu.be')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /Rule name/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Publish link rules' }))
    expect(await screen.findByText('GitHub needs at least one skill.')).toBeTruthy()
    expect(transport.publishAutomation).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Edit GitHub' }))
    expect(screen.getByRole('button', { name: 'Edit GitHub' }).getAttribute('aria-expanded')).toBe('true')
    await addSkill(user, 'GitHub', 'document-repo')
    expect(within(ruleRows()[0]!).getAllByText('/document-repo').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Edit YouTube' }))
    await addSkill(user, 'YouTube', 'transcribe')
    await user.click(screen.getByRole('button', { name: 'Actions for X' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete rule' }))
    await user.click(screen.getByRole('checkbox', { name: 'Enable rule GitHub' }))
    await user.click(screen.getByRole('checkbox', { name: 'Enable Inbox link automation' }))
    await user.click(screen.getByRole('button', { name: 'Publish link rules' }))

    await waitFor(() => expect(transport.publishAutomation).toHaveBeenCalledTimes(1))
    const request = publishedRequest(transport)
    expect(request.baseRevision).toBe(0)
    expect(request.policies).toMatchObject({ version: 1, revision: 1, enabled: true })
    expect(request.policies.policies).toMatchObject([
      { name: 'GitHub', enabled: true, priority: 2, match: { urlHosts: ['github.com'] }, skillIds: ['document-repo'], dispatcher: noDispatcher },
      { name: 'YouTube', enabled: false, priority: 1, match: { urlHosts: ['youtube.com', 'youtu.be'] }, skillIds: ['transcribe'] },
    ])
    expect(await screen.findByText('Inbox link rules published.')).toBeTruthy()
  })

  it('opens the rule actions menu outside the animated settings panel without scrolling it', async () => {
    const user = userEvent.setup()
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    // The settings panel slides in with a transform, which would become the containing block of a fixed menu.
    const { container } = render(<div style={{ transform: 'translateY(0)' }}><InboxLinkRules skills={skills} transport={threeRules()} canPublish /></div>)
    const trigger = await screen.findByRole('button', { name: 'Actions for Docs' })

    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Rule actions' })
    expect(container.contains(menu)).toBe(false)
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Delete rule' }))
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await user.click(trigger)
    await user.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('changes skills on a rule published through the API without touching its match', async () => {
    const user = userEvent.setup()
    const triage = {
      id: 'triage', name: 'Triage', enabled: true, priority: 3, match: { sourceKinds: ['shortcut'] },
      skillIds: ['research', 'transcribe'], dispatcher: { enabled: true, agentId: 'router', allowedSkillIds: ['research'] },
    }
    const transport = transportWith({ version: 1, revision: 4, enabled: true, policies: [legacyYoutubeRule, triage] })
    render(<InboxLinkRules skills={skills} transport={transport} canPublish />)

    await user.click(await screen.findByRole('button', { name: 'Edit YouTube links' }))
    expect(within(ruleRows()[0]!).getAllByText('Link type: YouTube').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Remove /transcribe from YouTube links' }))
    await addSkill(user, 'YouTube links', 'research')

    await user.click(screen.getByRole('button', { name: 'Edit Triage' }))
    expect(screen.queryByRole('combobox', { name: 'Add skill to Triage' })).toBeNull()
    expect(within(ruleRows()[1]!).getByText(/dispatcher chooses/i)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Publish link rules' }))
    await waitFor(() => expect(transport.publishAutomation).toHaveBeenCalledTimes(1))
    expect(publishedRequest(transport).policies.policies).toEqual([
      { ...legacyYoutubeRule, priority: 2, skillIds: ['research'] },
      { ...triage, priority: 1 },
    ])
  })

  it('reorders rules from the keyboard on the drag handle and publishes the new order', async () => {
    const user = userEvent.setup()
    const transport = threeRules()
    render(<InboxLinkRules skills={skills} transport={transport} canPublish />)

    await waitFor(() => expect(ruleRows()).toHaveLength(3))
    const handle = screen.getByRole('button', { name: 'Reorder YouTube links' })
    handle.focus()
    await user.keyboard('{ArrowUp}')

    expect(ruleNames()).toEqual(['YouTube links', 'Docs', 'Everything else'])
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reorder YouTube links' }))
    expect(screen.getByText('YouTube links moved to position 1 of 3.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Edit Everything else' }))
    expect(screen.getByRole('button', { name: 'Any link' }).getAttribute('aria-pressed')).toBe('true')

    await user.click(screen.getByRole('button', { name: 'Publish link rules' }))
    await waitFor(() => expect(transport.publishAutomation).toHaveBeenCalledTimes(1))
    const request = publishedRequest(transport)
    expect(request.baseRevision).toBe(7)
    expect(request.policies.revision).toBe(8)
    expect(request.policies.policies).toEqual([
      { ...legacyYoutubeRule, priority: 3 },
      { ...docsRule, priority: 2 },
      { ...anyRule, priority: 1 },
    ])
  })

  it('reorders rules by dragging the handle and cancels a drag with Escape', async () => {
    render(<InboxLinkRules skills={skills} transport={threeRules()} canPublish />)
    await waitFor(() => expect(ruleRows()).toHaveLength(3))
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = ruleRows().indexOf(this as HTMLLIElement)
      const top = Math.max(index, 0) * 50
      return { top, bottom: top + 40, height: 40, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }
    })

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Reorder Docs' }), { button: 0, clientY: 20 })
    fireEvent.pointerMove(document, { clientY: 140 })
    expect(ruleRows()[0]!.className).toContain('is-drag-source')
    expect(ruleRows()[2]!.className).toContain('is-drop-after')
    fireEvent.pointerUp(document, { clientY: 140 })

    expect(ruleNames()).toEqual(['YouTube links', 'Everything else', 'Docs'])
    expect(ruleRows().some((row) => row.className.includes('is-drag-source'))).toBe(false)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Reorder Docs' }), { button: 0, clientY: 120 })
    fireEvent.pointerMove(document, { clientY: 10 })
    expect(ruleRows()[0]!.className).toContain('is-drop-before')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerUp(document, { clientY: 10 })

    expect(ruleNames()).toEqual(['YouTube links', 'Everything else', 'Docs'])
  })

  it('normalizes added sites and rejects invalid ones inline', async () => {
    const user = userEvent.setup()
    const transport = transportWith({ version: 1, revision: 1, enabled: false, policies: [] })
    render(<InboxLinkRules skills={skills} transport={transport} canPublish />)

    await user.click(await screen.findByRole('button', { name: 'Add rule' }))
    const name = within(ruleRows()[0]!).getByRole('textbox', { name: /Rule name/ })
    await user.clear(name)
    await user.type(name, 'Papers')
    const siteInput = screen.getByRole('textbox', { name: 'Add site to Papers' })
    await user.type(siteInput, 'https://www.ArXiv.org/abs/1234{Enter}')
    await user.type(siteInput, 'localhost:3000{Enter}')

    expect(within(ruleRows()[0]!).getAllByText('arxiv.org').length).toBeGreaterThan(0)
    expect(screen.getByText('"localhost:3000" is not a valid site.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Remove arxiv.org from Papers' }))
    expect(within(ruleRows()[0]!).queryByText('arxiv.org')).toBeNull()
  })

  it('shows a reload prompt when the rules changed on the server', async () => {
    const user = userEvent.setup()
    const transport = transportWith({
      version: 1, revision: 2, enabled: true, policies: [anyRule],
    }, { publishAutomation: vi.fn(async () => { throw new Error('conflict: Automation policy revision conflict.') }) })
    render(<InboxLinkRules skills={skills} transport={transport} canPublish />)

    await user.click(await screen.findByRole('button', { name: 'Publish link rules' }))
    expect(await screen.findByText('Rules changed on the server. Reload to continue.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Reload rules' }))
    await waitFor(() => expect(transport.automation).toHaveBeenCalledTimes(2))
  })

  it('does not allow publishing when the published rules could not be loaded', async () => {
    const transport = transportWith(null, { automation: vi.fn(async () => { throw new Error('server unavailable') }) })
    render(<InboxLinkRules skills={skills} transport={transport} canPublish />)

    expect(await screen.findByText('server unavailable')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Publish link rules' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
