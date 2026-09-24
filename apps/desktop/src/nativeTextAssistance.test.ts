import { afterEach, describe, expect, it } from 'vitest'
import { TEXT_ASSISTANCE_OFF, disableNativeTextAssistance } from './nativeTextAssistance'

function expectAssistanceOff(element: Element) {
  for (const [name, value] of Object.entries(TEXT_ASSISTANCE_OFF)) {
    expect(element.getAttribute(name)).toBe(value)
  }
}

describe('disableNativeTextAssistance', () => {
  let stop: (() => void) | undefined

  afterEach(() => {
    stop?.()
    document.body.innerHTML = ''
  })

  it('stamps editable elements already in the document', () => {
    document.body.innerHTML = '<input id="a"><textarea id="b"></textarea><div id="c" contenteditable="true"></div>'
    stop = disableNativeTextAssistance()

    for (const id of ['a', 'b', 'c']) expectAssistanceOff(document.getElementById(id)!)
  })

  it('overrides explicit values that would re-enable assistance', () => {
    document.body.innerHTML = '<input id="a" spellcheck="true" autocorrect="on">'
    stop = disableNativeTextAssistance()

    expectAssistanceOff(document.getElementById('a')!)
  })

  it('stamps editable elements added or made editable later', async () => {
    stop = disableNativeTextAssistance()
    const wrapper = document.createElement('section')
    wrapper.innerHTML = '<input id="late">'
    const region = document.createElement('div')
    document.body.append(wrapper, region)
    region.setAttribute('contenteditable', 'true')
    await Promise.resolve()

    expectAssistanceOff(document.getElementById('late')!)
    expectAssistanceOff(region)
  })

  it('leaves non-editable elements alone', () => {
    document.body.innerHTML = '<div id="a"></div><div id="b" contenteditable="false"></div>'
    stop = disableNativeTextAssistance()

    expect(document.getElementById('a')!.hasAttribute('spellcheck')).toBe(false)
    expect(document.getElementById('b')!.hasAttribute('spellcheck')).toBe(false)
  })
})
