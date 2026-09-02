import { isIP } from 'node:net'
import { promises as dns } from 'node:dns'

export type PublicSourceType = 'youtube' | 'x' | 'webpage'

export interface PublicSourceIdentity {
  submittedUrl: string
  canonicalUrl: string
  type: PublicSourceType
  identity?: string
  host: string
}

export interface UrlInspectionAdapters {
  resolve?: (hostname: string) => Promise<string[]>
}

const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'])
const xHosts = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'])

export async function inspectPublicUrl(submittedUrl: string, adapters: UrlInspectionAdapters = {}): Promise<PublicSourceIdentity> {
  const identity = classifySourceUrl(submittedUrl)
  const addresses = isIP(identity.host)
    ? [identity.host]
    : await (adapters.resolve ?? resolveAddresses)(identity.host)
  if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error('Source URL must resolve only to public addresses.')
  }
  return identity
}

export function classifySourceUrl(submittedUrl: string): PublicSourceIdentity {
  let url: URL
  try { url = new URL(submittedUrl) } catch { throw new Error('Source URL is invalid.') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Source URL must use HTTP or HTTPS.')
  if (url.username || url.password) throw new Error('Source URL must not contain credentials.')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Source URL must resolve to a public address.')
  }
  if (isIP(host) && !isPublicAddress(host)) throw new Error('Source URL must resolve only to public addresses.')

  url.hostname = host
  url.hash = ''
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = ''

  if (youtubeHosts.has(host)) return youtubeIdentity(submittedUrl, url, host)
  if (xHosts.has(host)) return xIdentity(submittedUrl, url, host)
  return { submittedUrl, canonicalUrl: url.toString(), type: 'webpage', identity: undefined, host }
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  try {
    return (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
  } catch {
    throw new Error('Source URL hostname could not be resolved.')
  }
}

function youtubeIdentity(submittedUrl: string, url: URL, host: string): PublicSourceIdentity {
  let videoId: string | null = null
  if (host === 'youtu.be' || host === 'www.youtu.be') videoId = url.pathname.split('/').filter(Boolean)[0] ?? null
  else if (url.pathname === '/watch') videoId = url.searchParams.get('v')
  else {
    const match = /^\/(?:shorts|embed)\/([^/]+)\/?$/.exec(url.pathname)
    videoId = match?.[1] ?? null
  }
  if (!videoId || !/^[A-Za-z0-9_-]{6,64}$/.test(videoId)) throw new Error('YouTube URL does not contain a valid video identity.')
  return {
    submittedUrl,
    canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    type: 'youtube',
    identity: videoId,
    host: 'www.youtube.com',
  }
}

function xIdentity(submittedUrl: string, url: URL, _host: string): PublicSourceIdentity {
  const match = /^\/([A-Za-z0-9_]{1,50})\/status\/(\d{1,30})\/?$/.exec(url.pathname)
  if (!match) throw new Error('X status URL does not contain a valid post identity.')
  return {
    submittedUrl,
    canonicalUrl: `https://x.com/${match[1]}/status/${match[2]}${url.search}`,
    type: 'x',
    identity: match[2],
    host: 'x.com',
  }
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51)
      || (a === 203 && b === 0))
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    if (normalized.startsWith('::ffff:')) return isPublicAddress(normalized.slice(7))
    return normalized.startsWith('2') || normalized.startsWith('3')
  }
  return false
}
