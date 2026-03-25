import type { AncestorNode, SearchResult } from '../../store/ipc'

interface SearchResultItemProps {
  result: SearchResult
  ancestors: AncestorNode[]
}

/**
 * Renders a single search result row with a breadcrumb path and FTS5-highlighted snippet.
 * The snippet contains <mark> tags from FTS5's snippet() function — safe to use as
 * dangerouslySetInnerHTML because the content comes from our own database.
 */
export default function SearchResultItem({ result, ancestors }: SearchResultItemProps) {
  const breadcrumbParts = ['Home', ...ancestors.map((a) => a.name)]

  return (
    <div className="search-result-item">
      {breadcrumbParts.length > 0 && (
        <div className="search-result-breadcrumb">
          {breadcrumbParts.join(' > ')}
        </div>
      )}
      <div
        className="search-result-snippet"
        dangerouslySetInnerHTML={{ __html: result.snippet || '(no content)' }}
      />
    </div>
  )
}
