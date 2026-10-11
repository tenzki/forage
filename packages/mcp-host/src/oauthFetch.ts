import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

async function resolveDestination(url: URL, local: boolean, signal: AbortSignal) {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('OAuth network request cancelled.')); signal.addEventListener('abort', abort, { once: true }) })
  try {
    signal.throwIfAborted()
    const addresses = await Promise.race([lookup(host, { all: true, verbatim: true }), cancelled])
    const loopback = local && ['localhost', '127.0.0.1', '::1'].includes(host)
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address) && !(loopback && ['127.0.0.1', '::1'].includes(address)))) throw new TypeError('OAuth destination is not allowed.')
    return addresses[0]!
  } finally { signal.removeEventListener('abort', abort) }
}

export async function validateOAuthBrowserDestination(url: URL, resource: string, signal: AbortSignal): Promise<void> {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(resource).hostname)
  oauthDestination(url, local)
  await resolveDestination(url, local, AbortSignal.any([signal, AbortSignal.timeout(20_000)]))
}

export function oauthDestination(value: string | URL, local = false): URL {
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(host)
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(local && loopback && url.protocol === 'http:')))
    throw new TypeError('OAuth destination is not allowed.')
  if ((isIP(host) && !publicAddress(host)) && !(local && loopback)) throw new TypeError('OAuth destination is not allowed.')
  return url
}

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number)
    const [first, second] = parts
    return first !== 0 && first !== 10 && first !== 127 && first! < 224 && first !== 255
      && !(first === 169 && second === 254) && !(first === 172 && second! >= 16 && second! <= 31)
      && !(first === 192 && (second === 168 || second === 0)) && !(first === 100 && second! >= 64 && second! <= 127)
      && !(first === 198 && (second === 18 || second === 19))
  }
  if (isIP(address) !== 6) return false
  const normalized = address.toLowerCase()
  return /^[23][0-9a-f]{0,3}:/.test(normalized) && !normalized.startsWith('2001:db8:')
}

export function oauthFetch(resource: string, signal: AbortSignal, streaming = false): typeof fetch {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(resource).hostname)
  return async (input, init) => {
    const request = new Request(input, init)
    const url = oauthDestination(request.url, local)
    const combined = AbortSignal.any([signal, request.signal, AbortSignal.timeout(streaming ? 60_000 : 20_000)])
    combined.throwIfAborted()
    const address = await resolveDestination(url, local, combined)
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
    if (body && body.length > 100_000) throw new Error('OAuth request exceeds the size limit.')
    combined.throwIfAborted()
    return new Promise<Response>((resolve, reject) => {
      const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: request.method, headers: Object.fromEntries(request.headers), signal: combined,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
      }, (incoming) => {
        if (streaming && (incoming.statusCode ?? 500) < 300) {
          let bytes = 0
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              incoming.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2_000_000) incoming.destroy(new Error('MCP response exceeds the size limit.')); else { controller.enqueue(chunk); incoming.pause() } })
              incoming.on('end', () => controller.close())
              incoming.on('error', (error) => controller.error(error))
            },
            pull: () => { incoming.resume() }, cancel: () => { incoming.destroy() },
          })
          const headers = new Headers()
          for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
          const status = incoming.statusCode ?? 500
          resolve(new Response([204, 205].includes(status) ? null : body, { status, headers }))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 2_000_000) incoming.destroy(new TypeError('OAuth response exceeds the size limit.'))
          else chunks.push(chunk)
        })
        incoming.on('error', reject)
        incoming.on('end', () => {
          const status = incoming.statusCode ?? 500
          if (status >= 300 && status < 400) { reject(new TypeError('OAuth redirects are not allowed.')); return }
          const headers = new Headers()
          for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
          let bytes = Buffer.concat(chunks)
          if (status >= 400) {
            let code = 'server_error'
            try { const value = JSON.parse(bytes.toString('utf8')) as { error?: unknown }; if (typeof value.error === 'string' && /^[a-z_]{1,80}$/.test(value.error)) code = value.error } catch { }
            if (status === 401 || status === 403) code = 'invalid_grant'
            bytes = Buffer.from(JSON.stringify({ error: code }))
          }
          resolve(new Response([204, 205, 304].includes(status) ? null : bytes, { status, headers }))
        })
      })
      outgoing.on('error', reject)
      outgoing.end(body)
    })
  }
}
