const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** Normalizes user site input such as `https://www.GitHub.com/foo` to a bare domain, or returns null. */
export function normalizeSiteDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try { url = new URL(withScheme) } catch { return null }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.replace(/\.$/, '').replace(/^www\./, '')
  if (!host.includes('.') || host.startsWith('[') || ipv4.test(host)) return null
  if (host.endsWith('.localhost') || host.endsWith('.local')) return null
  return host
}
