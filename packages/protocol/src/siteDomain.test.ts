// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normalizeSiteDomain } from './siteDomain'

describe('normalizeSiteDomain', () => {
  it.each([
    ['github.com', 'github.com'],
    ['  GitHub.com  ', 'github.com'],
    ['https://www.GitHub.com/foo?bar=1#baz', 'github.com'],
    ['www.youtube.com', 'youtube.com'],
    ['youtu.be', 'youtu.be'],
    ['http://user:pass@news.example.org:8080/path', 'news.example.org'],
    ['x.com.', 'x.com'],
    ['gist.github.com/some/path', 'gist.github.com'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeSiteDomain(input)).toBe(expected)
  })

  it.each([
    '',
    '   ',
    'localhost',
    'localhost:3000',
    'app.localhost',
    'printer.local',
    'intranet',
    '127.0.0.1',
    '[::1]',
    'www.',
    'not a domain',
    'ftp://example.com',
  ])('rejects %j', (input) => {
    expect(normalizeSiteDomain(input)).toBeNull()
  })
})
