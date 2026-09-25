import { describe, expect, it } from 'vitest'
import { parseInline, parseReaderMarkdown, parseReaderResponse } from './readerDocument'

const BASE = 'https://zettelkasten.de/introduction/'

describe('reader document', () => {
  it('reads the title, source and body from a Jina response', () => {
    const doc = parseReaderResponse([
      'Title: Introduction to the Zettelkasten Method',
      'URL Source: https://zettelkasten.de/introduction/',
      'Published Time: 2026-03-01',
      '',
      'Markdown Content:',
      '# Introduction to the Zettelkasten Method',
      '',
      'A Zettelkasten is a personal tool for thinking and writing.',
      '',
      '## The principle of atomicity',
      '',
      '- One idea per note',
      '- Links earn their place',
    ].join('\n'), BASE, 0)

    expect(doc.title).toBe('Introduction to the Zettelkasten Method')
    expect(doc.host).toBe('zettelkasten.de')
    expect(doc.published).toBe('2026-03-01')
    // The repeated title heading is dropped; the header already shows it.
    expect(doc.blocks.map((block) => block.type)).toEqual(['paragraph', 'heading', 'list'])
    expect(doc.minutes).toBe(1)
  })

  it('keeps safe links, drops images and unsafe schemes', () => {
    expect(parseInline('See [the guide](/guide) ![logo](/logo.png) and [bad](javascript:alert(1))', BASE)).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'link', href: 'https://zettelkasten.de/guide', children: [{ type: 'text', text: 'the guide' }] },
      { type: 'text', text: '  and ' },
      { type: 'text', text: 'bad' },
      { type: 'text', text: ')' },
    ])
  })

  it('parses emphasis, code, quotes, rules and fenced code', () => {
    const blocks = parseReaderMarkdown([
      'Some **bold** and *soft* with `code`.',
      '',
      '> Quoted line',
      '',
      '---',
      '',
      '```',
      'const x = 1',
      '```',
    ].join('\n'), BASE)
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'quote', 'rule', 'code'])
    expect(blocks[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Some ' },
        { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'em', children: [{ type: 'text', text: 'soft' }] },
        { type: 'text', text: ' with ' },
        { type: 'code', text: 'code' },
        { type: 'text', text: '.' },
      ],
    })
  })
})
