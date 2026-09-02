export interface TranscriptRequest { videoId: string; canonicalUrl: string }
export interface TranscriptResult { text: string; language?: string }

export interface TranscriptProvider {
  transcript(request: TranscriptRequest, signal: AbortSignal): Promise<TranscriptResult>
}

export class ProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean) {
    super(message)
    this.name = 'ProviderError'
  }
}

interface SupadataOptions {
  apiUrl: string
  apiKey: string
  fetch?: typeof globalThis.fetch
  pollIntervalMs?: number
  deadlineMs?: number
}

export class SupadataTranscriptProvider implements TranscriptProvider {
  private readonly fetch: typeof globalThis.fetch
  private readonly pollIntervalMs: number
  private readonly deadlineMs: number

  constructor(private readonly options: SupadataOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.pollIntervalMs = Math.max(1, Math.min(options.pollIntervalMs ?? 2_000, 30_000))
    this.deadlineMs = Math.max(0, Math.min(options.deadlineMs ?? 120_000, 600_000))
  }

  async transcript(request: TranscriptRequest, signal: AbortSignal): Promise<TranscriptResult> {
    throwIfAborted(signal)
    const deadline = Date.now() + this.deadlineMs
    const response = await this.fetch(`${this.options.apiUrl.replace(/\/$/, '')}/youtube/transcript?url=${encodeURIComponent(request.canonicalUrl)}`, {
      method: 'GET', headers: { 'x-api-key': this.options.apiKey }, signal,
    })
    const body = await safeJson(response)
    this.requireSuccessful(response.status, body)
    const immediate = transcriptFrom(body)
    if (immediate) return immediate
    const jobId = stringField(body, 'jobId') ?? stringField(body, 'id')
    if (!jobId) throw new ProviderError('transcript_unavailable', 'Transcript provider returned no transcript.', false)

    while (Date.now() < deadline) {
      await abortableDelay(this.pollIntervalMs, signal)
      const poll = await this.fetch(`${this.options.apiUrl.replace(/\/$/, '')}/youtube/transcript/${encodeURIComponent(jobId)}`, {
        method: 'GET', headers: { 'x-api-key': this.options.apiKey }, signal,
      })
      const polled = await safeJson(poll)
      this.requireSuccessful(poll.status, polled)
      const result = transcriptFrom(polled)
      if (result) return result
      const status = stringField(polled, 'status')
      if (status && ['failed', 'error', 'unavailable'].includes(status.toLowerCase())) {
        throw new ProviderError('transcript_unavailable', 'Transcript is unavailable for this video.', false)
      }
    }
    throw new ProviderError('timeout', 'Transcript provider deadline was exceeded.', true)
  }

  private requireSuccessful(status: number, _body: unknown): void {
    if (status >= 200 && status < 300) return
    if (status === 404 || status === 422) throw new ProviderError('transcript_unavailable', 'Transcript is unavailable for this video.', false)
    if (status === 429) throw new ProviderError('provider_rate_limited', 'Transcript provider rate limited the request.', true)
    if (status >= 500) throw new ProviderError('dependency_unavailable', 'Transcript provider is temporarily unavailable.', true)
    throw new ProviderError('transcript_provider_rejected', 'Transcript provider rejected the request.', false)
  }
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length > 1_000_000) throw new ProviderError('invalid_provider_response', 'Transcript provider response is too large.', false)
  try { return text ? JSON.parse(text) : {} } catch { throw new ProviderError('invalid_provider_response', 'Transcript provider returned invalid data.', false) }
}

function transcriptFrom(value: unknown): TranscriptResult | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  let text = typeof record.transcript === 'string' ? record.transcript : typeof record.text === 'string' ? record.text : null
  if (!text && Array.isArray(record.content)) {
    text = record.content.map((entry) => {
      if (typeof entry === 'string') return entry
      return entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).text === 'string'
        ? String((entry as Record<string, unknown>).text) : ''
    }).filter(Boolean).join('\n')
  }
  if (!text) return null
  if (text.length > 100_000) throw new ProviderError('transcript_too_large', 'Transcript exceeds the 100000-character limit.', false)
  const language = stringField(record, 'language') ?? stringField(record, 'lang')
  return { text, ...(language ? { language } : {}) }
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.trim() ? field.trim().slice(0, 300) : null
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Transcript request cancelled.', 'AbortError')
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve() }, milliseconds)
    const abort = () => { cleanup(); reject(new DOMException('Transcript request cancelled.', 'AbortError')) }
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
