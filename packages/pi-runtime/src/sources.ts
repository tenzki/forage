import { normalizedSourceUrl } from '@forage/agent-runtime'

export interface SourceReference {
  url: string
  label: string
}

/**
 * URLs returned by successful source-reading tool calls in one run. A result may cite
 * only these; search-result links are leads, not verified sources.
 */
export class VerifiedSources {
  private readonly urls = new Set<string>()

  register(url: string): void {
    this.urls.add(normalizedSourceUrl(url))
  }

  has(url: string): boolean {
    return this.urls.has(normalizedSourceUrl(url))
  }

  /** Drop cited sources no source-reading tool returned in this run. */
  filter<T extends SourceReference>(sources: readonly T[]): T[] {
    return sources.filter((source) => this.has(source.url))
  }
}
