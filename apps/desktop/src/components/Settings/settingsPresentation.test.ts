import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const settingsStyles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'settings.css'), 'utf8')

let stylesheet: HTMLStyleElement
let screen: HTMLDivElement

beforeEach(() => {
  stylesheet = document.createElement('style')
  stylesheet.textContent = '.settings-panel { max-width: 760px; margin: 0 auto; padding: 24px 32px 48px; } .settings-section h2 { font-size: 17px; } .auth-card { padding: 14px; border: 1px solid; }'
    + '.custom-tool-form { margin-top: 6px; padding: 14px; border: 1px solid; } .settings-tools-section { margin-top: 28px; padding-top: 24px; border-top: 1px solid; } .extension-group { margin-top: 20px; } .extension-detail section > h3 { margin: 14px 0 4px; font-size: 13px; }'
    + settingsStyles
  document.head.append(stylesheet)
  screen = document.createElement('div')
  screen.className = 'settings-screen'
  screen.innerHTML = '<div class="settings-panel settings-layout"><section class="settings-section"><h2>General</h2><div class="auth-card compute-settings"></div><div class="mcp-tool-preview"></div></section></div>'
  document.body.append(screen)
})

afterEach(() => { stylesheet.remove(); screen.remove() })

describe('settings design cascade', () => {
  it('overrides legacy unlayered layout and heading rules only inside Settings', () => {
    const layout = getComputedStyle(screen.querySelector('.settings-layout')!)
    expect(layout.display).toBe('grid')
    expect(layout.maxWidth).toBe('none')
    expect(layout.marginLeft).toBe('0px')
    expect(layout.paddingTop).toBe('40px')
    expect(layout.paddingLeft).toBe('56px')
    expect(layout.gridTemplateColumns).toBe('180px minmax(0, 640px)')
    expect(getComputedStyle(screen.querySelector('h2')!).fontSize).toBe('18px')
    const unrelated = document.createElement('div')
    unrelated.className = 'settings-panel'
    document.body.append(unrelated)
    expect(getComputedStyle(unrelated).maxWidth).toBe('760px')
    unrelated.remove()
  })

  it('removes the legacy workspace card and renders one-line tool preview columns', () => {
    const compute = getComputedStyle(screen.querySelector('.compute-settings')!)
    expect(compute.paddingTop).toBe('0px')
    expect(compute.borderTopWidth).toBe('0px')
    const preview = getComputedStyle(screen.querySelector('.mcp-tool-preview')!)
    expect(preview.display).toBe('grid')
    expect(preview.gridTemplateColumns).toBe('20px minmax(0, 180px) minmax(0, 1fr) 34px')
  })

  it('keeps agent overview groups unboxed and editors at the design spacing', () => {
    screen.innerHTML = '<div class="settings-agent-overview"><section class="settings-section settings-group settings-tools-section"></section></div><section class="settings-section settings-editor"><div class="custom-tool-form agent-form"><textarea></textarea><div class="settings-tool-choice"><div><p>Search</p><div>Forage</div></div></div></div></section>'
    expect(getComputedStyle(screen.querySelector('.settings-agent-overview')!).gap).toBe('36px')
    const group = getComputedStyle(screen.querySelector('.settings-group')!)
    expect(group.marginTop).toBe('0px')
    expect(group.paddingTop).toBe('0px')
    expect(group.borderTopWidth).toBe('0px')
    const editor = getComputedStyle(screen.querySelector('.agent-form')!)
    expect(editor.gap).toBe('24px')
    expect(editor.paddingTop).toBe('0px')
    expect(editor.borderTopWidth).toBe('0px')
    expect(getComputedStyle(screen.querySelector('textarea')!).minHeight).toBe('120px')
    expect(getComputedStyle(screen.querySelector('.settings-tool-choice')!).minHeight).toBe('32px')
  })

  it('uses compact generic extension sections instead of legacy cards and heading margins', () => {
    screen.innerHTML = '<section class="settings-section extensions-settings"><section class="extension-group"><h3>Enabled</h3></section></section><section class="settings-section extension-detail"><div class="extension-detail-heading"><h2>Text Stats</h2></div><section class="settings-divider"><h3>Tools</h3><div class="settings-extension-executor"></div></section></section>'
    expect(getComputedStyle(screen.querySelector('.extensions-settings')!).gap).toBe('36px')
    expect(getComputedStyle(screen.querySelector('.extension-group')!).marginTop).toBe('0px')
    expect(getComputedStyle(screen.querySelector('.extension-group h3')!).fontSize).toBe('10px')
    expect(getComputedStyle(screen.querySelector('.extension-detail h2')!).fontSize).toBe('22px')
    expect(getComputedStyle(screen.querySelector('.extension-detail h3')!).marginTop).toBe('0px')
    expect(getComputedStyle(screen.querySelector('.extension-detail h3')!).fontSize).toBe('16px')
    expect(getComputedStyle(screen.querySelector('.settings-divider')!).paddingTop).toBe('24px')
    expect(getComputedStyle(screen.querySelector('.settings-extension-executor')!).display).toBe('flex')
  })

  it('matches the agent editor tool rows and MCP action spacing', () => {
    screen.innerHTML = '<div class="agent-form"><fieldset class="agent-tool-list settings-agent-tools"><legend>Tools</legend><div class="settings-agent-tool"><div class="settings-agent-tool-row"><button class="settings-agent-tool-name">Web search</button><span class="settings-agent-tool-source">Forage</span></div><p class="settings-agent-tool-description" hidden>Long description</p></div><section class="settings-agent-mcp"><div class="settings-agent-server"><div><p>Pen</p></div><div></div></div></section></fieldset><div class="settings-inherited-compute"></div></div>'
    expect(getComputedStyle(screen.querySelector('.settings-agent-tools')!).display).toBe('block')
    expect(getComputedStyle(screen.querySelector('legend')!).fontSize).toBe('18px')
    const row = getComputedStyle(screen.querySelector('.settings-agent-tool-row')!)
    expect(row.display).toBe('flex')
    expect(row.paddingTop).toBe('10px')
    expect(row.paddingBottom).toBe('10px')
    expect(row.gap).toBe('12px')
    expect(getComputedStyle(screen.querySelector('.settings-agent-tool-source')!).fontSize).toBe('11px')
    expect(getComputedStyle(screen.querySelector('.settings-agent-tool-description')!).display).toBe('none')
    expect(getComputedStyle(screen.querySelector('.settings-agent-server > div:last-child')!).gap).toBe('12px')
    expect(getComputedStyle(screen.querySelector('.settings-inherited-compute')!).gap).toBe('12px')
  })

  it('uses compact unboxed back links across nested settings pages', () => {
    screen.innerHTML = '<button class="settings-back-link">← Connection</button>'
    const back = getComputedStyle(screen.querySelector('button')!)
    expect(back.fontSize).toBe('12px')
    expect(back.minHeight).toBe('0px')
    expect(back.paddingTop).toBe('0px')
    expect(back.borderTopWidth).toBe('0px')
    expect(back.lineHeight).toBe('normal')
  })

  it('keeps MCP setup unboxed and diagnostics in grouped status rows', () => {
    screen.innerHTML = '<section class="settings-section"><div class="custom-tool-form mcp-connection-form"><form><fieldset class="settings-editor-fieldset settings-block"></fieldset></form><div class="settings-configuration-entry"></div></div><ul class="settings-row-list settings-diagnostic-results"><li class="settings-diagnostic-row"></li></ul></section>'
    const setup = getComputedStyle(screen.querySelector('.mcp-connection-form')!)
    expect(setup.gap).toBe('24px')
    expect(setup.borderTopWidth).toBe('0px')
    expect(getComputedStyle(screen.querySelector('fieldset')!).gap).toBe('24px')
    expect(getComputedStyle(screen.querySelector('.settings-configuration-entry')!).gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
    screen.querySelector('.settings-configuration-entry')!.classList.add('has-actions')
    expect(getComputedStyle(screen.querySelector('.settings-configuration-entry')!).gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr)) auto')
    expect(getComputedStyle(screen.querySelector('.settings-diagnostic-row')!).minHeight).toBe('68px')
  })
})
