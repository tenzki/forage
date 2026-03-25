import { useEffect, useRef, useState } from 'react'
import { Command } from 'cmdk'
import { searchNodesIpc, getAncestorsIpc } from '../../store/ipc'
import type { SearchResult, AncestorNode } from '../../store/ipc'
import { useTreeStore } from '../../store/treeStore'
import SearchResultItem from './SearchResultItem'

interface SearchOverlayProps {
  open: boolean
  onClose: () => void
}

interface SearchResultWithAncestors {
  result: SearchResult
  ancestors: AncestorNode[]
}

/**
 * Cmd+K search overlay powered by cmdk.
 *
 * - Debounces FTS5 search 200ms after input change.
 * - Fetches ancestor breadcrumbs for each result.
 * - Arrow keys + Enter handled by cmdk automatically.
 * - Escape closes via onOpenChange.
 */
export default function SearchOverlay({ open, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultWithAncestors[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reset state when overlay closes.
  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
      setIsLoading(false)
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
    }
  }, [open])

  function handleValueChange(value: string) {
    setQuery(value)

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
    }

    if (!value.trim()) {
      setResults([])
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    debounceTimer.current = setTimeout(async () => {
      try {
        const searchResults = await searchNodesIpc(value)
        // Fetch ancestors in parallel for each result.
        const withAncestors = await Promise.all(
          searchResults.map(async (result) => {
            const ancestors = await getAncestorsIpc(result.id)
            return { result, ancestors }
          })
        )
        setResults(withAncestors)
      } catch (e) {
        console.error('Search failed:', e)
        setResults([])
      } finally {
        setIsLoading(false)
      }
    }, 200)
  }

  function handleSelect(result: SearchResult) {
    useTreeStore.getState().zoomIn(result.id)
    onClose()
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
      label="Search all nodes"
      className="search-overlay-dialog"
      shouldFilter={false}
    >
      <Command.Input
        placeholder="Search all nodes..."
        value={query}
        onValueChange={handleValueChange}
      />
      <Command.List>
        {isLoading && <Command.Loading>Searching...</Command.Loading>}
        {!isLoading && query.trim() && results.length === 0 && (
          <Command.Empty>No results found.</Command.Empty>
        )}
        {results.map(({ result, ancestors }) => (
          <Command.Item
            key={result.id}
            value={result.id}
            onSelect={() => handleSelect(result)}
          >
            <SearchResultItem result={result} ancestors={ancestors} />
          </Command.Item>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
