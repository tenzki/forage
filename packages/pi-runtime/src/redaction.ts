import { createAssistantMessageEventStream, type Models } from '@earendil-works/pi-ai'

export function redactCredentialText(text: string, secrets: readonly string[] = []): string {
  let value = text
  for (const secret of secrets) if (secret.length >= 8) value = value.split(secret).join('[redacted]')
  return value
    .replace(/(?:\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+\S+)/gi, '[redacted]')
    .replace(/((?:refresh[_-]?token|access[_-]?token|api[_-]?key|device[_-]?code)\s*[=:]\s*)[^\s,;"']+/gi, '$1[redacted]')
}

/** Redact before values reach the Harness, including live partials and tool intents. */
export function redactValue<T>(value: T, secrets: readonly string[], partial = false): T {
  if (typeof value === 'string') {
    let text = redactCredentialText(value, secrets)
    // A live partial must not persist most of a credential just because its last
    // bytes have not arrived. Hold any meaningful suffix matching a known prefix.
    if (partial) for (const secret of secrets) {
      if (secret.length < 8) continue
      for (let size = Math.min(secret.length - 1, text.length); size >= 4; size -= 1) {
        if (text.endsWith(secret.slice(0, size))) { text = `${text.slice(0, -size)}[redacted]`; break }
      }
    }
    return text as T
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, partial)) as T
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets, partial)]),
  ) as T
  return value
}

export function redactedModels(models: Models, secrets: () => readonly string[], assertOwnership?: () => Promise<void>): Models {
  return new Proxy(models, {
    get(target, key) {
      if (key === 'streamSimple' || key === 'streamDeferred') {
        return (...args: Parameters<Models['streamSimple']>) => {
          const stream = createAssistantMessageEventStream()
          const signal = args[2]?.signal
          const fail = (error: unknown, aborted = false) => {
            const message = {
              role: 'assistant' as const, content: [], api: args[0].api, provider: args[0].provider, model: args[0].id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: aborted ? 'aborted' as const : 'error' as const, timestamp: Date.now(),
              errorMessage: redactCredentialText(error instanceof Error ? error.message : 'Model request failed.', secrets()),
            }
            stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message })
          }
          // A provider that ignores cancellation must not hold shutdown open.
          const abort = () => fail(new Error('Model request aborted.'), true)
          signal?.addEventListener('abort', abort, { once: true })
          void (async () => {
            try {
              if (signal?.aborted) { abort(); return }
              await assertOwnership?.()
              if (signal?.aborted) return
              const source = Reflect.apply(target[key], target, args) as ReturnType<Models['streamSimple']>
              for await (const event of source) {
                if (signal?.aborted) break
                stream.push(redactValue(event, secrets(), event.type !== 'done' && event.type !== 'error'))
              }
              if (!signal?.aborted) stream.end(redactValue(await source.result(), secrets()))
            } catch (error) { fail(error, signal?.aborted) }
            finally { signal?.removeEventListener('abort', abort) }
          })()
          return stream
        }
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
