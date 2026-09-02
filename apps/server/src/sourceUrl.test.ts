// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { inspectPublicUrl } from './sourceUrl'

describe('public source URL inspection', () => {
  const publicDns = vi.fn(async () => ['142.250.74.206'])

  it.each([
    ['https://youtu.be/dQw4w9WgXcQ?t=3#fragment', 'youtube', 'dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://twitter.com/example/status/1234567890#reply', 'x', '1234567890', 'https://x.com/example/status/1234567890'],
    ['https://example.com/article#comments', 'webpage', undefined, 'https://example.com/article'],
  ])('canonicalizes %s', async (submittedUrl, type, identity, canonicalUrl) => {
    await expect(inspectPublicUrl(submittedUrl, { resolve: publicDns })).resolves.toMatchObject({
      submittedUrl, type, identity, canonicalUrl,
    })
  })

  it('rejects embedded credentials and private/special-use resolutions', async () => {
    await expect(inspectPublicUrl('https://user:pass@example.com/', { resolve: publicDns })).rejects.toThrow(/credentials/i)
    for (const address of ['127.0.0.1', '10.0.0.3', '169.254.1.2', '192.168.1.1', '::1', 'fc00::1']) {
      await expect(inspectPublicUrl('https://example.com/', { resolve: async () => [address] })).rejects.toThrow(/public/i)
    }
  })

  it('rejects unsupported schemes and malformed known-source identities', async () => {
    await expect(inspectPublicUrl('file:///etc/passwd', { resolve: publicDns })).rejects.toThrow(/HTTP/i)
    await expect(inspectPublicUrl('https://youtu.be/not-valid!', { resolve: publicDns })).rejects.toThrow(/YouTube/i)
    await expect(inspectPublicUrl('https://x.com/user/status/not-a-number', { resolve: publicDns })).rejects.toThrow(/X status/i)
  })
})
